/**
 * Apply a validated plan to the tree. Deterministic: same tree + same plan gives
 * the same files. Every change is recorded in the report the commit message uses.
 */
import fs from "node:fs";
import { LIMITS, type DreamPlan } from "./plan.js";
import { FOLDERS, PROFILE_FILE, bulletKey, listFiles, removeFile, safePath, writeFile, type MemoryFile } from "./layout.js";

export interface ApplyReport {
  created: string[];
  updated: string[];
  corrected: string[];
  completed: string[];
  deleted: string[];
  warnings: string[];
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((b) => {
    const k = bulletKey(b);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function applyPlan(root: string, plan: DreamPlan, day: string): ApplyReport {
  const report: ApplyReport = { created: [], updated: [], corrected: [], completed: [], deleted: [], warnings: [] };
  const byId = new Map<string, MemoryFile>(listFiles(root).map((f) => [f.id, f]));

  for (const op of plan.operations) {
    const existing = byId.get(op.id);
    switch (op.op) {
      case "upsert": {
        if (existing && existing.folder !== op.folder) {
          report.warnings.push(`upsert ${op.id}: it lives in ${existing.folder}, not ${op.folder}; updated it in place`);
        }
        const f: MemoryFile = existing ?? {
          id: op.id,
          folder: op.folder,
          type: FOLDERS[op.folder],
          title: op.title ?? op.id,
          aliases: [],
          created: day,
          updated: day,
          bullets: [],
          links: [],
        };
        if (op.title) f.title = op.title;
        if (op.aliases) f.aliases = dedupe([...f.aliases, ...op.aliases]);
        if (op.remove) {
          const gone = new Set(op.remove.map(bulletKey));
          f.bullets = f.bullets.filter((b) => !gone.has(bulletKey(b)));
        }
        if (op.add) {
          const have = new Set(f.bullets.map(bulletKey));
          for (const b of op.add) if (!have.has(bulletKey(b))) f.bullets.push(`${b} (${day})`);
        }
        if (op.links) f.links = [...new Set([...f.links, ...op.links])].filter((l) => l !== f.id);
        if (f.bullets.length > LIMITS.bulletsPerFile) {
          report.warnings.push(`${f.id} has ${f.bullets.length} lines; the next dream should condense it`);
        }
        f.updated = day;
        writeFile(root, f);
        byId.set(f.id, f);
        (existing ? report.updated : report.created).push(f.id);
        break;
      }
      case "correct": {
        if (!existing) {
          report.warnings.push(`correct ${op.id}: no such file`);
          break;
        }
        const key = bulletKey(op.old);
        const idx = existing.bullets.findIndex((b) => bulletKey(b) === key || bulletKey(b).includes(key));
        const line = `${op.new} (corrected ${day})`;
        if (idx >= 0) existing.bullets[idx] = line;
        else existing.bullets.push(line);
        existing.updated = day;
        writeFile(root, existing);
        report.corrected.push(existing.id);
        break;
      }
      case "complete": {
        if (!existing || existing.folder !== "workstreams/active") {
          report.warnings.push(`complete ${op.id}: not an active workstream`);
          break;
        }
        removeFile(root, existing);
        existing.folder = "workstreams/completed";
        existing.bullets.push(`Done${op.note ? `: ${op.note}` : ""} (${day})`);
        existing.updated = day;
        writeFile(root, existing);
        report.completed.push(existing.id);
        break;
      }
      case "delete": {
        if (!existing) break;
        // Git history keeps the old file; the tree only holds what is true now.
        removeFile(root, existing);
        byId.delete(existing.id);
        report.deleted.push(`${existing.id} (${op.reason})`);
        break;
      }
    }
  }

  if (plan.profile) fs.writeFileSync(safePath(root, PROFILE_FILE), plan.profile.trim() + "\n");
  if (plan.daily.length) appendTimeline(root, `timeline/daily/${day}.md`, `# ${day}`, plan.daily);
  return report;
}

/** Append bullets under a heading; a second dream on the same day adds to the same file. */
export function appendTimeline(root: string, rel: string, heading: string, bullets: string[]): void {
  const file = safePath(root, rel);
  fs.mkdirSync(safePath(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : `${heading}\n\n`;
  const have = new Set(existing.split("\n").filter((l) => l.startsWith("- ")).map((l) => bulletKey(l.slice(2))));
  const add = bullets.filter((b) => !have.has(bulletKey(b))).map((b) => `- ${b}`);
  if (add.length) fs.writeFileSync(file, `${existing.trimEnd()}\n${add.join("\n")}\n`);
}
