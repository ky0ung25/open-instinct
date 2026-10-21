/**
 * The raw turn log: one JSON line per message, one file per local day. The runtime
 * appends to it as messages come and go; nothing else writes it. The dream reads
 * every turn newer than its cursor.
 */
import fs from "node:fs";
import { localDate } from "./time.js";
import { safePath } from "./layout.js";

export interface Turn {
  /** ISO timestamp. */
  ts: string;
  /** "owner" is the business owner, "assistant" is the agent, "other" is anyone else (staff, customers). */
  role: "owner" | "assistant" | "other";
  text: string;
  channel?: string;
  /** Sender address for "other" turns. */
  from?: string;
}

export function logPath(root: string, day: string): string {
  return safePath(root, "log", `${day}.jsonl`);
}

/** Append one turn. Call this from the runtime for every inbound and outbound message. */
export function logTurn(root: string, turn: Turn, timeZone = "UTC"): void {
  const day = localDate(new Date(turn.ts), timeZone);
  const file = logPath(root, day);
  fs.mkdirSync(safePath(root, "log"), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(turn) + "\n");
}

/** Every turn strictly newer than `since` (ISO), oldest first. */
export function readTurnsSince(root: string, since: string | undefined): Turn[] {
  const dir = safePath(root, "log");
  if (!fs.existsSync(dir)) return [];
  const sinceMs = since ? Date.parse(since) : -Infinity;
  // Log files are named by day; skip whole days that end before the cursor (one day of slack for time zones).
  const sinceDay = since ? since.slice(0, 10) : "";
  const turns: Turn[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const day = name.slice(0, -6);
    if (sinceDay && day < shiftDay(sinceDay, -1)) continue;
    for (const line of fs.readFileSync(`${dir}/${name}`, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as Turn;
        if (typeof t.ts === "string" && typeof t.text === "string" && Date.parse(t.ts) > sinceMs) turns.push(t);
      } catch {
        // A torn last line from a crash: skip it, the next append starts a fresh line.
      }
    }
  }
  return turns.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
