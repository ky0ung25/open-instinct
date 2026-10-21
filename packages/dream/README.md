# @open-instinct/dream

Nightly "dreaming" memory. The assistant never writes memory during a conversation. Once a night, a background job reads the day's conversations and rewrites a git-tracked tree of markdown files. The assistant reads the result: a one-page `PROFILE.md` in every prompt, plus a search tool for everything else.

This follows how Instinct's memory looks from the outside, per [supermemory's teardown](https://supermemory.ai/blog/reverse-engineering-instinct-memory/): a tree of small markdown files with `id`, `type` and `aliases` headers, `[[id]]` links, a daily background update (a preference took about 23 hours to show up), reconciliation commits, and read-only access for the agent.

## The tree

```
memory/
  PROFILE.md                     one-pager loaded into every prompt
  entities/people/<id>.md        customers, staff, family
  entities/orgs/<id>.md          the business, vendors, partners
  knowledge/facts/<id>.md        services, prices, hours
  knowledge/preferences/<id>.md  how the owner wants things done
  knowledge/decisions/<id>.md    choices made, so nobody asks twice
  workstreams/active/<id>.md     open jobs with a next step
  workstreams/completed/<id>.md
  timeline/daily/YYYY-MM-DD.md
  timeline/weekly/YYYY-Www.md    written on Sundays
  log/YYYY-MM-DD.jsonl           raw turns, append-only: the dream's input
  .dream-state.json              cursor: the last turn already dreamed
  .git/                          one commit per dream
```

A file:

```markdown
---
id: prices
type: fact
aliases: ["price list", "menu"]
created: 2026-10-20
updated: 2026-10-21
---
# Prices

- Women's cut: $55 (corrected 2026-10-21)
- Men's cut: $35 (2026-10-20)

## Links
- [[luna-hair-studio]]
```

See [examples/dream-sample](../../examples/dream-sample) for a full tree after two nights.

## One dream

1. **Read** every turn in `log/` newer than the cursor. No new turns: stop, no commit.
2. **Pick context**: the current profile, a one-line index of every file, and the full text of files the day touches (named by id, title or alias, or sharing words), plus all preferences and active workstreams. This keeps the prompt small as memory grows.
3. **Ask the model** for a plan, forced as a tool call so the reply is always JSON: `daily` bullets, `operations` (`upsert`, `correct`, `complete`, `delete`) and the new `profile`. On Sundays it also writes `weekly`.
4. **Validate**: slugs only, known folders only, no path tricks, size caps, and anything that looks like a card number, password or sign-in code is dropped.
5. **Apply**: new lines are dated, corrections are marked `(corrected <date>)`, finished workstreams move to `completed/`, and dropped plans are deleted (git keeps the old version).
6. **Commit** with a message listing every change, so each night can be reviewed or reverted.

The dream prompt (`DREAM_SYSTEM` in `src/prompt.ts`) carries the rules the teardown saw in Instinct's commits: keep only what matters next week, move temporary details into workstreams, turn repeated examples into one trait, correct wrong facts with a date, remove what the owner says is off.

## Using it

```ts
import { logTurn, memoryDigest, searchMemory, runDream, anthropicDreamModel, startDreamLoop } from "@open-instinct/dream";

// 1. In the runtime, for every message in and out:
logTurn(root, { ts: new Date().toISOString(), role: "owner", text, channel: "imessage" }, "America/New_York");

// 2. In the system prompt, every turn:
const memory = memoryDigest(root); // PROFILE.md + what was said since last night

// 3. As a read-only tool for the agent:
searchMemory(root, "Mike wedding");

// 4. Every night, one business at a time:
startDreamLoop({ tenants: listTenants, model: anthropicDreamModel({ apiKey }), hour: 3, timeZone: "America/New_York" });
```

Or from system cron:

```
0 3 * * *  ANTHROPIC_API_KEY=... instinct-dream --root /data/tenants/luna/memory --tz America/New_York
```

Same-day facts are not lost before the dream runs: `memoryDigest` adds everything said since the last dream under its own heading.

## Cost

One model call per business per night that had conversations. Quiet businesses cost nothing. The prompt holds the profile, the index and only the touched files, so it stays roughly the size of one day's chat plus a few thousand tokens.

## Not wired in yet

- `packages/core` still has `memory_write`; for Instinct-style memory, remove that tool so the dream is the only writer, swap `MemoryStore.digest()` for `memoryDigest()`, and register `searchMemory` as a `memory_search` tool.
- Each SMB tenant needs its own memory root, so one business's memory never reaches another's prompt.
