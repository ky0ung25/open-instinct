/**
 * The memory tree. Same shape the Instinct teardown reports: one markdown file per
 * subject, a short header (id, type, aliases), then one fact per bullet, linked
 * with [[id]]. The whole tree is a git repo, so every dream is a commit and old
 * versions stay in history.
 *
 *   memory/
 *     PROFILE.md                     one-pager the prompt loads every turn
 *     entities/people/<id>.md        customers, staff, family
 *     entities/orgs/<id>.md          vendors, partners, the business itself
 *     knowledge/facts/<id>.md        services, prices, hours, addresses
 *     knowledge/preferences/<id>.md  how the owner wants things done
 *     knowledge/decisions/<id>.md    choices made, with the date
 *     workstreams/active/<id>.md     open jobs: "launch website", "quote for Mike"
 *     workstreams/completed/<id>.md
 *     timeline/daily/YYYY-MM-DD.md   what happened each day
 *     timeline/weekly/YYYY-Www.md
 *     log/YYYY-MM-DD.jsonl           raw turns, append-only; the dream's input
 */
import fs from "node:fs";
import path from "node:path";

export const FOLDERS = {
  "entities/people": "person",
  "entities/orgs": "org",
  "knowledge/facts": "fact",
  "knowledge/preferences": "preference",
  "knowledge/decisions": "decision",
  "workstreams/active": "workstream",
  "workstreams/completed": "workstream",
} as const;

export type Folder = keyof typeof FOLDERS;
export type MemoryType = (typeof FOLDERS)[Folder];

export const PROFILE_FILE = "PROFILE.md";
export const STATE_FILE = ".dream-state.json";
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isFolder(s: string): s is Folder {
  return Object.prototype.hasOwnProperty.call(FOLDERS, s);
}

export interface MemoryFile {
  id: string;
  folder: Folder;
  type: MemoryType;
  title: string;
  aliases: string[];
  created: string;
  updated: string;
  bullets: string[];
  links: string[];
}

/** Resolve a path inside the memory root, refusing anything that escapes it. */
export function safePath(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`path escapes memory root: ${parts.join("/")}`);
  return target;
}

function yamlList(items: string[]): string {
  return `[${items.map((a) => JSON.stringify(a)).join(", ")}]`;
}

export function serialize(f: MemoryFile): string {
  const lines = [
    "---",
    `id: ${f.id}`,
    `type: ${f.type}`,
    `aliases: ${yamlList(f.aliases)}`,
    `created: ${f.created}`,
    `updated: ${f.updated}`,
    "---",
    `# ${f.title}`,
    "",
    ...f.bullets.map((b) => `- ${b}`),
  ];
  if (f.links.length > 0) lines.push("", "## Links", ...f.links.map((l) => `- [[${l}]]`));
  return lines.join("\n") + "\n";
}

export function parse(text: string, folder: Folder, fallbackId: string): MemoryFile {
  const fm: Record<string, string> = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    for (const line of (m[1] ?? "").split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    body = text.slice(m[0].length);
  }
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(fm.aliases ?? "[]");
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    aliases = [];
  }
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? fallbackId;
  const [main, linkPart = ""] = body.split(/^## Links\s*$/m);
  const bullets = (main ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
  const links = [...linkPart.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]!).filter(Boolean);
  return {
    id: fm.id || fallbackId,
    folder,
    type: FOLDERS[folder],
    title,
    aliases,
    created: fm.created ?? "",
    updated: fm.updated ?? "",
    bullets,
    links,
  };
}

/** Every memory file in the tree. */
export function listFiles(root: string): MemoryFile[] {
  const out: MemoryFile[] = [];
  for (const folder of Object.keys(FOLDERS) as Folder[]) {
    const dir = safePath(root, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".md")) continue;
      const id = name.slice(0, -3);
      out.push(parse(fs.readFileSync(path.join(dir, name), "utf8"), folder, id));
    }
  }
  return out;
}

export function writeFile(root: string, f: MemoryFile): void {
  const dir = safePath(root, f.folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(safePath(root, f.folder, `${f.id}.md`), serialize(f));
}

export function removeFile(root: string, f: Pick<MemoryFile, "folder" | "id">): void {
  fs.rmSync(safePath(root, f.folder, `${f.id}.md`), { force: true });
}

/** Strip a trailing "(YYYY-MM-DD)" or "(corrected YYYY-MM-DD)" so bullets compare by meaning. */
export function bulletKey(b: string): string {
  return b
    .replace(/\s*\((?:corrected |updated )?\d{4}-\d{2}-\d{2}[^)]*\)\s*$/i, "")
    .trim()
    .toLowerCase();
}
