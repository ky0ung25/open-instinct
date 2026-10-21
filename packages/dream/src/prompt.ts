/**
 * The dream prompt. The rules mirror what the Instinct teardown saw in its nightly
 * commits: durable facts only, temporary details into workstreams, examples
 * generalized into traits, incidental detail dropped, wrong facts corrected with a
 * date, and "that's not happening" removed.
 */
import fs from "node:fs";
import type { Turn } from "./log.js";
import { PROFILE_FILE, safePath, serialize, type MemoryFile } from "./layout.js";

export const DREAM_SYSTEM = `You are the memory of a small business's AI assistant. Once a night you read the day's conversations and update the memory files. The assistant never writes memory itself; you are the only writer.

The memory is a tree of short markdown files, one subject per file:
- entities/people: customers, staff, family. entities/orgs: vendors, partners, the business itself.
- knowledge/facts: services, prices, hours, addresses, how things work.
- knowledge/preferences: how the owner wants things done, their tone, what they hate.
- knowledge/decisions: choices the owner made, so the assistant does not ask again.
- workstreams/active: open jobs with a next step ("launch website", "quote for Mike"). Complete them when they are done or dropped.

Rules:
1. Keep only what will still matter next week. Drop small talk, one-off logistics and anything already done.
2. Temporary details (a delivery Thursday, a quote in progress) go in a workstream, not in facts.
3. When the owner shows the same preference twice, write the general trait ("prefers short, warm replies"), not each example.
4. Write facts people stated. Never store your own guesses, the assistant's suggestions the owner did not accept, or what a stranger claims about the owner.
5. If something in memory is now wrong, use "correct" with the old line and the new one. If the owner says a plan is off, complete or delete it.
6. Reuse existing files. Match by id, title and aliases before creating a new one. Add aliases for nicknames and spellings you see.
7. Never store card or account numbers, passwords, sign-in codes or ID numbers.
8. Lines are short: one fact each, under 25 words, no dates (the system adds them).
9. Rewrite PROFILE.md every night as the one-page brief the assistant reads before every message. Sections, in order: Business, Owner, How the owner likes to work (tone, what needs approval first), Active work, Key people. At most 3,500 characters. It must reflect the files after your changes.
10. "daily" is what happened today, 3 to 10 short past-tense bullets.

Call save_dream exactly once.`;

const MAX_TURN_CHARS = 60_000;
const MAX_FILE_CHARS = 24_000;

function hhmm(ts: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts));
}

export function formatTurns(turns: Turn[], timeZone: string): string {
  const lines = turns.map((t) => {
    const who = t.role === "other" ? `other${t.from ? ` (${t.from})` : ""}` : t.role;
    return `[${hhmm(t.ts, timeZone)}] ${who}: ${t.text.replace(/\s+/g, " ").trim()}`;
  });
  let text = lines.join("\n");
  if (text.length > MAX_TURN_CHARS) text = `(earlier turns omitted)\n${text.slice(text.length - MAX_TURN_CHARS)}`;
  return text;
}

const STOP = new Set(
  "the and for are was were you your our with this that have has had not but can will just they them their there what when then than from into out about also very its it's i'm we're".split(" "),
);

function stem(w: string): string {
  return w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem);
}

/**
 * Which files to show in full. Every file appears in the index; full text goes to
 * files the day names (id, title or alias), files that share at least two words
 * with the day, and all preferences and active workstreams, best match first, up
 * to a budget.
 */
export function relevantFiles(files: MemoryFile[], dayText: string): MemoryFile[] {
  const dayWords = new Set(words(dayText));
  const named = ` ${words(dayText).join(" ")} `;
  const score = (f: MemoryFile): number => {
    let s = 0;
    for (const name of [f.id.replace(/-/g, " "), f.title, ...f.aliases]) {
      const w = words(name);
      if (w.length > 0 && named.includes(` ${w.join(" ")} `)) s += 10;
    }
    const shared = new Set(words(f.bullets.join(" ")).filter((w) => dayWords.has(w))).size;
    if (shared >= 2) s += shared;
    if (f.folder === "knowledge/preferences" || f.folder === "workstreams/active") s += 1;
    return s;
  };
  const ranked = files
    .map((f) => ({ f, s: score(f) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const out: MemoryFile[] = [];
  let used = 0;
  for (const { f } of ranked) {
    const size = serialize(f).length;
    if (used + size > MAX_FILE_CHARS) continue;
    out.push(f);
    used += size;
  }
  return out;
}

export interface DreamPromptInput {
  root: string;
  day: string;
  timeZone: string;
  turns: Turn[];
  files: MemoryFile[];
  /** Daily summaries of the week, when this dream also writes the weekly rollup. */
  week?: { label: string; days: Array<{ day: string; text: string }> };
}

export function buildDreamPrompt(input: DreamPromptInput): string {
  const profilePath = safePath(input.root, PROFILE_FILE);
  const profile = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8").trim() : "(empty: this is the first night)";
  const index = input.files.length
    ? input.files.map((f) => `- ${f.id} | ${f.folder} | ${f.title}${f.aliases.length ? ` | aka ${f.aliases.join(", ")}` : ""}`).join("\n")
    : "(no files yet)";
  const transcript = formatTurns(input.turns, input.timeZone);
  const full = relevantFiles(input.files, transcript);
  const parts = [
    `Today is ${input.day} (${input.timeZone}).`,
    `## Current PROFILE.md\n${profile}`,
    `## Index of all memory files (id | folder | title | aliases)\n${index}`,
    `## Files that today's conversations touch, in full\n${full.length ? full.map((f) => `### ${f.folder}/${f.id}.md\n${serialize(f)}`).join("\n") : "(none)"}`,
    `## Today's conversations\n${transcript}`,
  ];
  if (input.week) {
    parts.push(
      `## This week's daily summaries (${input.week.label})\n${input.week.days.map((d) => `### ${d.day}\n${d.text}`).join("\n")}\n\nAlso fill "weekly": 5 to 10 bullets summarizing the week, including today.`,
    );
  }
  return parts.join("\n\n");
}
