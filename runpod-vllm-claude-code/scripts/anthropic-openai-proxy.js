#!/usr/bin/env node
// Translates Anthropic's Messages API (what Claude Code speaks) into OpenAI's
// chat.completions format (what vLLM speaks), so Claude Code can be pointed at
// any vLLM-hosted model via ANTHROPIC_BASE_URL.
//
// Usage:
//   VLLM_URL=https://<pod>-8000.proxy.runpod.net PORT=<free-port> SERVED_MODEL=<name> \
//     node anthropic-openai-proxy.js
//
// Real bugs found and fixed here the hard way (see SKILL.md "Known gotchas" for the
// full story on each — don't re-derive this file from scratch, these are non-obvious):
//   1. Claude Code's default max_tokens request (often 32000) can exceed a small
//      --max-model-len, so it's clamped before forwarding (MAX_TOKENS_CAP).
//   2. Claude Code interleaves role:"system" messages mid-conversation (system-reminders),
//      but vLLM's chat templates require system to be the very first message only.
//      Any non-leading system/other role is folded into "user".
//   3. A single long blocking (non-streamed) backend call — e.g. generating a big
//      /compact summary with reasoning — can exceed RunPod's edge-proxy idle timeout,
//      which returns an HTML error page instead of JSON. Always request stream:true
//      from vLLM so bytes keep flowing continuously; this sidesteps that timeout
//      entirely regardless of total generation time.
//   4. vLLM's streaming final usage chunk can report prompt_tokens as 0 on some
//      requests (seen after heavy tool-call turns). Claude Code uses that number for
//      its own auto-compact timing, so a false 0 risks silently repeating the
//      context-overflow bug — fall back to a rough character-count estimate whenever
//      the backend gives us nothing usable (fallbackInputTokens below).

const http = require('http');

const VLLM_URL = process.env.VLLM_URL;
const SERVED_MODEL = process.env.SERVED_MODEL || 'local-model';
const PORT = process.env.PORT || 8787;
const MAX_TOKENS_CAP = Number(process.env.MAX_TOKENS_CAP || 4096);

if (!VLLM_URL) {
  console.error('VLLM_URL env var required (e.g. https://<podId>-8000.proxy.runpod.net)');
  process.exit(1);
}

function anthropicToolsToOpenAI(tools) {
  if (!tools) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));
}

function anthropicToolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

function blockTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b.type === 'text' ? b.text : '')).join('');
  return '';
}

// Anthropic message roles are only ever "user" / "assistant" at the top level, but
// Claude Code also interleaves role:"system" turns (system-reminders) mid-conversation.
// vLLM's chat template rejects a non-leading system message outright, so anything
// that isn't user/assistant gets folded into user.
function anthropicMessagesToOpenAI(system, messages) {
  const out = [];
  const sysText = blockTextOf(system);
  if (sysText) out.push({ role: 'system', content: sysText });

  for (const m of messages) {
    const role = (m.role === 'user' || m.role === 'assistant') ? m.role : 'user';

    if (typeof m.content === 'string') {
      out.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) continue;

    if (role === 'user') {
      const toolResults = m.content.filter(b => b.type === 'tool_result');
      const textBlocks = m.content.filter(b => b.type === 'text');
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: blockTextOf(tr.content) || '' });
      }
      const text = textBlocks.map(b => b.text).join('');
      if (text) out.push({ role: 'user', content: text });
      continue;
    }

    if (role === 'assistant') {
      const textBlocks = m.content.filter(b => b.type === 'text');
      const toolUses = m.content.filter(b => b.type === 'tool_use');
      const msg = { role: 'assistant', content: textBlocks.map(b => b.text).join('') || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map(tu => ({
          id: tu.id,
          type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        }));
      }
      out.push(msg);
      continue;
    }
  }
  return out;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function roughTokens(s) {
  return Math.max(1, Math.ceil((s || '').length / 4));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      if (req.method === 'POST' && req.url.startsWith('/v1/messages/count_tokens')) {
        const parsed = JSON.parse(body || '{}');
        const text = anthropicMessagesToOpenAI(parsed.system, parsed.messages || []).map(m => m.content || '').join(' ');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: roughTokens(text) }));
        return;
      }

      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }

      const anthropicReq = JSON.parse(body || '{}');
      console.log(`[proxy] -> ${anthropicReq.messages?.length || 0} msgs, tools=${anthropicReq.tools?.length || 0}, stream=${!!anthropicReq.stream}`);

      const openaiMessages = anthropicMessagesToOpenAI(anthropicReq.system, anthropicReq.messages || []);
      // vLLM can report prompt_tokens as 0 on some large/prefix-cached requests. That's
      // fine for billing but Claude Code uses input_tokens for its own auto-compact timing,
      // so a false "0" risks silently repeating the earlier context-overflow bug. Fall back
      // to a rough character-count estimate whenever the backend gives us nothing usable.
      const fallbackInputTokens = roughTokens(JSON.stringify(openaiMessages));
      const openaiReq = {
        model: SERVED_MODEL,
        messages: openaiMessages,
        max_tokens: Math.min(anthropicReq.max_tokens || MAX_TOKENS_CAP, MAX_TOKENS_CAP),
        temperature: anthropicReq.temperature ?? 0.7,
        tools: anthropicToolsToOpenAI(anthropicReq.tools),
        tool_choice: anthropicToolChoiceToOpenAI(anthropicReq.tool_choice),
        // Always stream to vLLM: a single long blocking response can exceed RunPod's
        // edge-proxy idle timeout on a big compact/summary generation. Streaming keeps
        // bytes flowing continuously so that timeout never triggers, regardless of how
        // long the total generation takes.
        stream: true,
        stream_options: { include_usage: true },
      };

      const backendRes = await fetch(`${VLLM_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(openaiReq),
      });

      if (!backendRes.ok) {
        const errText = await backendRes.text().catch(() => '');
        console.error('[proxy] backend error', errText.slice(0, 500));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'backend error' } }));
        return;
      }

      const msgId = `msg_${Math.random().toString(36).slice(2)}`;
      const wantsClientStream = !!anthropicReq.stream;

      if (wantsClientStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
      }

      let anthropicBlockIndex = 0;
      let textBlockIndex = null;
      let textAccum = '';
      const toolBlocks = new Map(); // openai tool index -> { anthropicIndex, id, name, argsBuffer }
      let finishReason = null;
      let usage = { input_tokens: fallbackInputTokens, output_tokens: 0 };
      let messageStarted = false;

      const ensureMessageStart = () => {
        if (messageStarted || !wantsClientStream) return;
        messageStarted = true;
        sse(res, 'message_start', {
          type: 'message_start',
          message: { id: msgId, type: 'message', role: 'assistant', content: [], model: anthropicReq.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: fallbackInputTokens, output_tokens: 0 } },
        });
      };

      const reader = backendRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // keep the last (possibly incomplete) line for next read

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;

          let chunk;
          try { chunk = JSON.parse(payload); } catch (e) { continue; }

          if (chunk.usage) {
            usage = {
              input_tokens: chunk.usage.prompt_tokens || fallbackInputTokens,
              output_tokens: chunk.usage.completion_tokens || 0,
            };
          }

          const choice = chunk.choices && chunk.choices[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta || {};

          if (delta.content) {
            ensureMessageStart();
            textAccum += delta.content;
            if (textBlockIndex === null) {
              textBlockIndex = anthropicBlockIndex++;
              if (wantsClientStream) sse(res, 'content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
            }
            if (wantsClientStream) sse(res, 'content_block_delta', { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text: delta.content } });
          }

          if (delta.tool_calls) {
            ensureMessageStart();
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolBlocks.has(idx)) {
                const anthropicIndex = anthropicBlockIndex++;
                toolBlocks.set(idx, { anthropicIndex, id: tc.id, name: tc.function?.name, argsBuffer: '' });
                if (wantsClientStream) sse(res, 'content_block_start', { type: 'content_block_start', index: anthropicIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function?.name, input: {} } });
              }
              const entry = toolBlocks.get(idx);
              if (tc.function?.arguments) {
                entry.argsBuffer += tc.function.arguments;
                if (wantsClientStream) sse(res, 'content_block_delta', { type: 'content_block_delta', index: entry.anthropicIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
              }
            }
          }
        }
      }

      const stopReason = toolBlocks.size > 0 ? 'tool_use' : (finishReason === 'length' ? 'max_tokens' : 'end_turn');

      if (!wantsClientStream) {
        const contentBlocks = [];
        if (textAccum) contentBlocks.push({ type: 'text', text: textAccum });
        for (const entry of toolBlocks.values()) {
          let input = {};
          try { input = JSON.parse(entry.argsBuffer || '{}'); } catch (e) {}
          contentBlocks.push({ type: 'tool_use', id: entry.id, name: entry.name, input });
        }
        if (contentBlocks.length === 0) contentBlocks.push({ type: 'text', text: '' });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: msgId, type: 'message', role: 'assistant', model: anthropicReq.model,
          content: contentBlocks, stop_reason: stopReason, stop_sequence: null, usage,
        }));
        return;
      }

      ensureMessageStart();
      if (textBlockIndex !== null) sse(res, 'content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
      for (const entry of toolBlocks.values()) sse(res, 'content_block_stop', { type: 'content_block_stop', index: entry.anthropicIndex });

      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      sse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    } catch (err) {
      console.error('[proxy] error', err);
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(err) } }));
      } catch (e) {}
    }
  });
});

server.listen(PORT, () => console.log(`[proxy] listening on :${PORT} -> ${VLLM_URL} (served model: ${SERVED_MODEL})`));
