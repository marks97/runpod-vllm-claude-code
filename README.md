# Runpod Vllm Claude Code

> A [Claude Code](https://code.claude.com/docs/en/skills) skill.

Deploy any HuggingFace model to RunPod as a vLLM server, bridge it to Claude Code (which speaks Anthropic's Messages API, not OpenAI's), smoke-test that tool-calling actually works end to end, and tear everything down with zero trace (pod, network volumes, local processes, scratch files). Use this whenever you want to run a model on RunPod, try a model with Claude Code, test whether a HF/GGUF/abliterated checkpoint supports tool use, benchmark a model for coding-agent use, or spin up/kill a disposable GPU inference box. Also trigger it for anything about hooking Claude Code up to a non-Anthropic backend (vLLM, Ollama, LM Studio) via ANTHROPIC_BASE_URL, or questions like 'what GPU do I need to run X' and 'how much will it cost to run this model'.

## Install

Via [skills.sh](https://skills.sh):

```bash
npx skills add marks97/runpod-vllm-claude-code
```

Or manually — copy the `runpod-vllm-claude-code/` folder into your `.claude/skills/` directory.

## Usage

Once installed, Claude invokes this skill automatically when your request matches
what it does (see the triggers in [`runpod-vllm-claude-code/SKILL.md`](runpod-vllm-claude-code/SKILL.md)). You can
also ask for it by name.

See [`runpod-vllm-claude-code/SKILL.md`](runpod-vllm-claude-code/SKILL.md) for the full workflow, scripts, and options.

## License

MIT © Marc Amoros

