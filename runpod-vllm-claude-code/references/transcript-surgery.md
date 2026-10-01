# Recovering from a bad `/compact` — manual transcript surgery

Two attempts at this got it wrong before the third one worked, on a real session, with
the user watching and increasingly (and reasonably) angry each time. The mistakes are
as instructive as the fix — read them, don't just skip to the recipe.

## Why this is possible at all

A Claude Code transcript (`.jsonl`) is append-only, and `/compact` does **not** delete
the raw prior messages — it adds new entries that tell *future* turns to use a summary
instead of replaying everything before it. The raw history is still physically in the
file. That means "undo the compact" is a real, achievable edit: cut the file back to
before the compact happened, and resuming replays the real history again.

The catch is that a transcript is not a flat log — it is a **parent-chain tree**.
Entries carry `parentUuid`/`uuid` links (and sometimes a `logicalParentUuid` that
differs from `parentUuid`), and line position in the file is not the same thing as
position in the conversation the model actually sees on resume.

## A compact event is a PAIR, and the trigger is the first one, not the second

What actually happens on `/compact` is two consecutive entries:

1. A `system` entry carrying a `compactMetadata` field, and often a
   `logicalParentUuid` distinct from `parentUuid` — **this is the real trigger**.
2. Immediately after it, a `user` entry with `isCompactSummary: true` — this is just
   the human-readable summary text that follows the trigger.

**Mistake #1** was cutting the file right after removing the `isCompactSummary`
entry, but *keeping* the `compactMetadata` system entry that came before it. The
summary text was gone, but the trigger entry itself apparently still told Claude
Code's resume logic "a compaction boundary exists here" — the resumed context came
back tiny (a few thousand tokens) instead of the expected ~130K. Cutting one line
later than the real boundary reproduced the exact problem it was trying to fix.

**Mistake #2**, before that: there were actually **two separate compact events** in
the transcript (one from an earlier failed retry loop, one from later), and the fix
only accounted for the second one. Removing the second compact's aftermath still left
the first compact's summary sitting further back in the kept portion of the file — so
the "restored" context was still built on top of a summary, just an earlier one.

**The fix**: search the *whole* file for every occurrence, not just the first match
you find, and cut before the `system`/`compactMetadata` entry specifically, not the
`user`/`isCompactSummary` entry that follows it.

```bash
python3 -c "
import json
with open('<transcript.jsonl>') as f:
    lines = f.readlines()
for i, line in enumerate(lines):
    line = line.strip()
    if not line or 'compact' not in line.lower(): continue
    try: o = json.loads(line)
    except: continue
    print(i, o.get('type'), o.get('timestamp'),
          'isCompactSummary=', o.get('isCompactSummary'),
          'has_compactMetadata=', 'compactMetadata' in o)
"
```

Cut to keep `lines[:index_of_the_compactMetadata_system_entry]` — one line index
*before* the pair, not before just the summary half of it.

## The procedure

1. **Confirm zero writers before touching the file.** `ps aux | grep -i "claude.*<session-id>"`
   must return nothing. Two processes writing one transcript corrupts it. If a session
   is live, ask the user to exit it first (Ctrl+C twice) — don't assume it's already
   closed.
2. **Back up before truncating**, every time, even under pressure to move fast:
   `cp -a <file> <file>.bak-$(date +%Y%m%d-%H%M%S)`. Don't delete the backup until the
   user has confirmed the resumed session actually looks right.
3. **Find every compact marker** with the script above — don't assume there's only
   one just because you found one.
4. **Cut before the earliest `compactMetadata` system entry** you want to roll back
   past (`lines[:index]`, write back with `open(f,'w').writelines(kept)`).
5. **Have the user resume**, then verify with the "watching a live session's context
   usage" recipe in the main SKILL.md — check the *next real completion's*
   `usage.input_tokens`, not just that the command ran without error. A number close
   to what the conversation actually held before the compact (not a suspiciously
   small one) is the only real confirmation the cut was correct.
6. **Only delete the backup once that number checks out.** If it's still small,
   the cut was one boundary off again — go back to step 3, don't guess a third time
   without re-showing your reasoning to the user first.

## What NOT to do

- Don't read the actual message content while doing this unless the user explicitly
  says it's fine — structural fields (`type`, `timestamp`, `isCompactSummary`,
  presence of `compactMetadata`) are enough to find the right cut point, and this is
  the user's real conversation history.
- Don't assume "the summary marker is gone" means "the compaction's effect is gone."
  Verify with a real post-resume token count, not by re-reading the diff you made.
- Don't skip the backup because the user is in a hurry. Both real mistakes here were
  recoverable specifically because a backup existed at each step.
