/**
 * One night's dream for one business:
 *   1. read every turn since the last dream
 *   2. show the model the profile, the index and the files the day touches
 *   3. validate its plan, apply it, rewrite PROFILE.md and the daily timeline
 *   4. on Sundays, also write the weekly rollup
 *   5. move the cursor and commit
 * Safe to run twice: no new turns means nothing happens.
 */
import fs from "node:fs";
import { applyPlan, appendTimeline, type ApplyReport } from "./apply.js";
import { commitAll } from "./git.js";
import { FOLDERS, STATE_FILE, listFiles, safePath } from "./layout.js";
import { readTurnsSince } from "./log.js";
import type { DreamModel } from "./model.js";
import { PLAN_SCHEMA, validatePlan, type DreamPlan } from "./plan.js";
import { DREAM_SYSTEM, buildDreamPrompt } from "./prompt.js";
import { isoWeek, localDate, localWeekday, weekDays } from "./time.js";

export interface DreamOptions {
  /** The memory root for one business. */
  root: string;
  model: DreamModel;
  timeZone?: string;
  now?: Date;
  /** Validate and return the plan without writing anything. */
  dryRun?: boolean;
}

export interface DreamReport extends ApplyReport {
  day: string;
  turns: number;
  skipped?: string;
  weekly?: string;
  commit?: string;
  plan?: DreamPlan;
}

interface DreamState {
  lastTurnTs?: string;
  lastRunAt?: string;
}

function readState(root: string): DreamState {
  try {
    return JSON.parse(fs.readFileSync(safePath(root, STATE_FILE), "utf8")) as DreamState;
  } catch {
    return {};
  }
}

export function ensureTree(root: string): void {
  for (const dir of [...Object.keys(FOLDERS), "timeline/daily", "timeline/weekly", "log"]) {
    fs.mkdirSync(safePath(root, dir), { recursive: true });
  }
}

export async function runDream(opts: DreamOptions): Promise<DreamReport> {
  const tz = opts.timeZone ?? "UTC";
  const now = opts.now ?? new Date();
  const root = opts.root;
  ensureTree(root);

  const state = readState(root);
  const turns = readTurnsSince(root, state.lastTurnTs);
  const empty: ApplyReport = { created: [], updated: [], corrected: [], completed: [], deleted: [], warnings: [] };
  const lastTs = turns.at(-1)?.ts;
  const day = lastTs ? localDate(new Date(lastTs), tz) : localDate(now, tz);
  if (turns.length === 0) return { ...empty, day, turns: 0, skipped: "no new conversations since the last dream" };

  const files = listFiles(root);
  const promptInput: Parameters<typeof buildDreamPrompt>[0] = { root, day, timeZone: tz, turns, files };
  const rollup = localWeekday(new Date(`${day}T12:00:00Z`), "UTC") === 0;
  const week = isoWeek(day);
  if (rollup) {
    const days = weekDays(day)
      .filter((d) => d !== day)
      .map((d) => {
        const p = safePath(root, "timeline/daily", `${d}.md`);
        return { day: d, text: fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "" };
      })
      .filter((d) => d.text);
    promptInput.week = { label: week, days };
  }

  const raw = await opts.model({ system: DREAM_SYSTEM, user: buildDreamPrompt(promptInput), schema: PLAN_SCHEMA });
  const { plan, warnings } = validatePlan(raw);
  if (opts.dryRun) return { ...empty, warnings, day, turns: turns.length, plan };

  const report = applyPlan(root, plan, day);
  report.warnings.unshift(...warnings);
  const out: DreamReport = { ...report, day, turns: turns.length };
  if (rollup && plan.weekly?.length) {
    appendTimeline(root, `timeline/weekly/${week}.md`, `# ${week}`, plan.weekly);
    out.weekly = week;
  }

  const next: DreamState = { lastTurnTs: lastTs, lastRunAt: now.toISOString() };
  fs.writeFileSync(safePath(root, STATE_FILE), JSON.stringify(next, null, 2) + "\n");

  const counts = [
    report.created.length && `+${report.created.length} new`,
    report.updated.length && `${report.updated.length} updated`,
    report.corrected.length && `${report.corrected.length} corrected`,
    report.completed.length && `${report.completed.length} done`,
    report.deleted.length && `${report.deleted.length} removed`,
  ].filter(Boolean);
  const body = [
    ...report.created.map((x) => `new: ${x}`),
    ...report.updated.map((x) => `updated: ${x}`),
    ...report.corrected.map((x) => `corrected: ${x}`),
    ...report.completed.map((x) => `done: ${x}`),
    ...report.deleted.map((x) => `removed: ${x}`),
    ...report.warnings.map((x) => `warning: ${x}`),
  ];
  const commit = commitAll(root, `dream ${day}: ${counts.join(", ") || "profile and timeline"} (${turns.length} turns)\n\n${body.join("\n")}`);
  if (commit) out.commit = commit;
  return out;
}
