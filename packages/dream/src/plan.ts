/**
 * What one dream returns, and the checks every plan passes before it touches disk.
 * The model proposes; this file decides what is allowed. Anything invalid is
 * dropped with a warning, never half-applied.
 */
import { FOLDERS, SLUG, isFolder, type Folder } from "./layout.js";

export type DreamOp =
  | { op: "upsert"; folder: Folder; id: string; title?: string; aliases?: string[]; add?: string[]; remove?: string[]; links?: string[] }
  | { op: "correct"; folder: Folder; id: string; old: string; new: string }
  | { op: "complete"; id: string; note?: string }
  | { op: "delete"; folder: Folder; id: string; reason: string };

export interface DreamPlan {
  /** Bullets for timeline/daily/<day>.md. */
  daily: string[];
  operations: DreamOp[];
  /** The whole new PROFILE.md body, markdown. */
  profile: string;
  /** Bullets for timeline/weekly/<week>.md; only on rollup days. */
  weekly?: string[];
}

export const LIMITS = {
  operations: 60,
  bulletsPerOp: 20,
  bulletChars: 300,
  bulletsPerFile: 40,
  profileChars: 6000,
  dailyBullets: 25,
};

/** Things a memory file must never hold: card and account numbers, sign-in codes, passwords. */
const SECRET = [
  /\b(?:\d[ -]?){13,19}\b/, // card-like digit runs
  /\b(?:password|passcode|pin)\s*(?:is|:)/i,
  /\b(?:code|otp)\s*(?:is|:)?\s*\d{4,8}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN shape
];

export function looksSecret(s: string): boolean {
  return SECRET.some((re) => re.test(s));
}

/** JSON schema the model must fill; sent as a forced tool call. */
export const PLAN_SCHEMA = {
  type: "object",
  required: ["daily", "operations", "profile"],
  properties: {
    daily: { type: "array", items: { type: "string" }, description: "What happened today, one short past-tense bullet each" },
    weekly: { type: "array", items: { type: "string" }, description: "Only when asked: the week's summary bullets" },
    profile: { type: "string", description: "The complete new PROFILE.md body in markdown" },
    operations: {
      type: "array",
      items: {
        type: "object",
        required: ["op", "id"],
        properties: {
          op: { type: "string", enum: ["upsert", "correct", "complete", "delete"] },
          folder: { type: "string", enum: Object.keys(FOLDERS) },
          id: { type: "string", description: "lowercase-kebab-case slug, unique across the whole tree" },
          title: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          add: { type: "array", items: { type: "string" } },
          remove: { type: "array", items: { type: "string" } },
          links: { type: "array", items: { type: "string" } },
          old: { type: "string" },
          new: { type: "string" },
          note: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

type Dict = Record<string, unknown>;

function strs(v: unknown, max: number, chars: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.replace(/\s+/g, " ").trim().slice(0, chars))
    .filter(Boolean)
    .slice(0, max);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function validatePlan(raw: unknown): { plan: DreamPlan; warnings: string[] } {
  const warnings: string[] = [];
  const d = (raw && typeof raw === "object" ? raw : {}) as Dict;
  const keep = (list: string[], where: string) =>
    list.filter((b) => {
      if (looksSecret(b)) {
        warnings.push(`dropped a line that looked like a secret (${where})`);
        return false;
      }
      return true;
    });

  const plan: DreamPlan = {
    daily: keep(strs(d.daily, LIMITS.dailyBullets, LIMITS.bulletChars), "daily"),
    operations: [],
    profile: (str(d.profile) ?? "").slice(0, LIMITS.profileChars),
  };
  if (d.weekly !== undefined) plan.weekly = keep(strs(d.weekly, LIMITS.dailyBullets, LIMITS.bulletChars), "weekly");
  if (plan.profile && looksSecret(plan.profile)) {
    warnings.push("profile looked like it held a secret; kept the old profile");
    plan.profile = "";
  }

  const ops = Array.isArray(d.operations) ? d.operations : [];
  if (ops.length > LIMITS.operations) warnings.push(`plan had ${ops.length} operations; kept the first ${LIMITS.operations}`);
  for (const item of ops.slice(0, LIMITS.operations)) {
    const o = (item && typeof item === "object" ? item : {}) as Dict;
    const id = str(o.id)?.toLowerCase();
    if (!id || !SLUG.test(id)) {
      warnings.push(`skipped an operation with a bad id: ${JSON.stringify(o.id)}`);
      continue;
    }
    const folder = str(o.folder);
    switch (o.op) {
      case "upsert": {
        if (!folder || !isFolder(folder) || folder === "workstreams/completed") {
          warnings.push(`skipped upsert ${id}: bad folder ${JSON.stringify(folder)}`);
          continue;
        }
        const op: DreamOp = { op: "upsert", folder, id };
        const title = str(o.title);
        if (title) op.title = title.slice(0, 120);
        const aliases = strs(o.aliases, 12, 60);
        if (aliases.length) op.aliases = aliases;
        const add = keep(strs(o.add, LIMITS.bulletsPerOp, LIMITS.bulletChars), id);
        if (add.length) op.add = add;
        const remove = strs(o.remove, LIMITS.bulletsPerOp, LIMITS.bulletChars);
        if (remove.length) op.remove = remove;
        const links = strs(o.links, 20, 64).map((l) => l.toLowerCase()).filter((l) => SLUG.test(l));
        if (links.length) op.links = links;
        plan.operations.push(op);
        break;
      }
      case "correct": {
        const old = str(o.old);
        const next = str(o.new);
        if (!folder || !isFolder(folder) || !old || !next) {
          warnings.push(`skipped correct ${id}: needs folder, old and new`);
          continue;
        }
        if (looksSecret(next)) {
          warnings.push(`dropped a correction that looked like a secret (${id})`);
          continue;
        }
        plan.operations.push({ op: "correct", folder, id, old, new: next.slice(0, LIMITS.bulletChars) });
        break;
      }
      case "complete": {
        const op: DreamOp = { op: "complete", id };
        const note = str(o.note);
        if (note) op.note = note.slice(0, LIMITS.bulletChars);
        plan.operations.push(op);
        break;
      }
      case "delete": {
        if (!folder || !isFolder(folder)) {
          warnings.push(`skipped delete ${id}: bad folder`);
          continue;
        }
        plan.operations.push({ op: "delete", folder, id, reason: str(o.reason) ?? "no longer true" });
        break;
      }
      default:
        warnings.push(`skipped an unknown operation ${JSON.stringify(o.op)}`);
    }
  }
  return { plan, warnings };
}
