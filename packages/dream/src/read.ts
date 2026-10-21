/**
 * The read side. The assistant never writes memory; it gets the one-page profile
 * every turn, plus what was said since last night (not dreamed yet), and a
 * keyword search tool over the tree for anything else.
 */
import fs from "node:fs";
import { PROFILE_FILE, STATE_FILE, listFiles, safePath, serialize } from "./layout.js";
import { readTurnsSince } from "./log.js";

/** What goes in the system prompt every turn. */
export function memoryDigest(root: string, maxChars = 6000): string {
  const profilePath = safePath(root, PROFILE_FILE);
  const profile = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8").trim() : "";
  let since: string | undefined;
  try {
    since = (JSON.parse(fs.readFileSync(safePath(root, STATE_FILE), "utf8")) as { lastTurnTs?: string }).lastTurnTs;
  } catch {
    since = undefined;
  }
  const recent = readTurnsSince(root, since)
    .filter((t) => t.role !== "assistant")
    .map((t) => `- ${t.role}: ${t.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
  const budget = Math.max(0, maxChars - profile.length - 80);
  const tail = recent.length > budget ? `...\n${recent.slice(recent.length - budget)}` : recent;
  return [profile, tail && `## Said since last night (not in memory yet)\n${tail}`].filter(Boolean).join("\n\n");
}

export interface SearchHit {
  id: string;
  folder: string;
  title: string;
  score: number;
  text: string;
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
}

/**
 * Keyword search over memory files and timelines. Names, ids and aliases count
 * three times as much as body lines. Exact words only, like the teardown found
 * Instinct's search to be: aliases are what make nicknames and typos findable.
 */
export function searchMemory(root: string, query: string, limit = 5): SearchHit[] {
  const q = [...new Set(words(query))];
  if (q.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const f of listFiles(root)) {
    const head = new Set(words([f.id.replace(/-/g, " "), f.title, ...f.aliases].join(" ")));
    const body = words(f.bullets.join(" "));
    let score = 0;
    for (const w of q) {
      if (head.has(w)) score += 3;
      score += body.filter((b) => b === w).length;
    }
    if (score > 0) hits.push({ id: f.id, folder: f.folder, title: f.title, score, text: serialize(f) });
  }
  for (const sub of ["timeline/daily", "timeline/weekly"]) {
    const dir = safePath(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(`${dir}/${name}`, "utf8");
      const body = words(text);
      const score = q.reduce((s, w) => s + body.filter((b) => b === w).length, 0);
      if (score > 0) hits.push({ id: name.replace(/\.md$/, ""), folder: sub, title: name, score, text });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
