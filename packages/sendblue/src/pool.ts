/**
 * The shared line pool. Many owners share a few Sendblue lines; this decides which
 * line is each owner's "home", routes every inbound (person, line) pair to exactly
 * one tenant, counts daily traffic per line, and moves owners off a flagged line.
 *
 * The one hard rule: a person may have at most one tenant per line. Their phone
 * shows one thread per number, so two tenants on one line would merge into one
 * thread with one name. A person with two businesses gets two different lines.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type LineStatus = "active" | "flagged" | "retired";

export interface PoolLine {
  /** E.164. */
  number: string;
  status: LineStatus;
  /** Most tenants (owners' businesses) to home on this line. */
  maxTenants: number;
  /** Combined inbound + outbound messages per day this line should stay under. */
  dailyBudget: number;
  /** True when this line's plan may text someone first (needed to move owners after a flag). */
  canStartConversations?: boolean;
  addedAt: string;
}

export interface Connection {
  /** The person's phone, E.164. */
  person: string;
  line: string;
  tenantId: string;
  createdAt: string;
  /** Set when this connection was moved off a flagged line and the person has not texted the new one yet. */
  movedFrom?: string;
}

export interface PoolSnapshot {
  lines: PoolLine[];
  connections: Connection[];
  /** `${line}|${day}` -> messages counted that day. */
  usage: Record<string, number>;
}

export interface PoolStore {
  load(): PoolSnapshot;
  save(s: PoolSnapshot): void;
}

export class MemoryPoolStore implements PoolStore {
  private snap: PoolSnapshot = { lines: [], connections: [], usage: {} };
  load(): PoolSnapshot {
    return structuredClone(this.snap);
  }
  save(s: PoolSnapshot): void {
    this.snap = structuredClone(s);
  }
}

/** One JSON file, written atomically. Fine for a single server; swap for a database later. */
export class FilePoolStore implements PoolStore {
  constructor(private readonly file: string) {}
  load(): PoolSnapshot {
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PoolSnapshot>;
      return { lines: s.lines ?? [], connections: s.connections ?? [], usage: s.usage ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lines: [], connections: [], usage: {} };
      throw err;
    }
  }
  save(s: PoolSnapshot): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.file);
  }
}

export class NoLineAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoLineAvailableError";
  }
}

export interface PoolOptions {
  store?: PoolStore;
  now?: () => Date;
  /** Day boundary for usage counts. Sendblue resets its caps at 3 AM ET. */
  timeZone?: string;
  /** Called once per line per day when its count crosses this share of dailyBudget. Default 0.7. */
  alertAt?: number;
  onAlert?: (line: string, count: number, budget: number) => void;
}

export interface UsageResult {
  line: string;
  day: string;
  count: number;
  budget: number;
  ratio: number;
}

export class LinePool {
  private readonly store: PoolStore;
  private snap: PoolSnapshot;
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly alertAt: number;
  private readonly onAlert: PoolOptions["onAlert"];

  constructor(opts: PoolOptions = {}) {
    this.store = opts.store ?? new MemoryPoolStore();
    this.snap = this.store.load();
    this.now = opts.now ?? (() => new Date());
    this.timeZone = opts.timeZone ?? "America/New_York";
    this.alertAt = opts.alertAt ?? 0.7;
    this.onAlert = opts.onAlert;
  }

  private persist(): void {
    this.store.save(this.snap);
  }

  lines(): PoolLine[] {
    return this.snap.lines.map((l) => ({ ...l }));
  }

  connections(): Connection[] {
    return this.snap.connections.map((c) => ({ ...c }));
  }

  addLine(number: string, opts: Partial<Omit<PoolLine, "number" | "addedAt">> = {}): PoolLine {
    if (this.snap.lines.some((l) => l.number === number)) throw new Error(`Line ${number} is already in the pool`);
    const line: PoolLine = {
      number,
      status: opts.status ?? "active",
      maxTenants: opts.maxTenants ?? 400,
      dailyBudget: opts.dailyBudget ?? 3000,
      addedAt: this.now().toISOString(),
    };
    if (opts.canStartConversations) line.canStartConversations = true;
    this.snap.lines.push(line);
    this.persist();
    return { ...line };
  }

  setStatus(number: string, status: LineStatus): void {
    const line = this.snap.lines.find((l) => l.number === number);
    if (!line) throw new Error(`Unknown line ${number}`);
    line.status = status;
    this.persist();
  }

  private tenantsOn(line: string): number {
    return new Set(this.snap.connections.filter((c) => c.line === line).map((c) => c.tenantId)).size;
  }

  /** The tenant a (person, line) pair belongs to, if any. Every inbound goes through here. */
  resolve(person: string, line: string): Connection | undefined {
    const c = this.snap.connections.find((x) => x.person === person && x.line === line);
    return c ? { ...c } : undefined;
  }

  /** Where this person reaches this tenant. */
  homeLine(person: string, tenantId: string): string | undefined {
    return this.snap.connections.find((c) => c.person === person && c.tenantId === tenantId)?.line;
  }

  /**
   * Give this person a home line for this tenant. Reuses the tenant's existing line when
   * the person can join it (staff texting their boss's assistant see the same number),
   * else the least-loaded active line where the person has no other tenant.
   */
  assign(person: string, tenantId: string): Connection {
    const existing = this.snap.connections.find((c) => c.person === person && c.tenantId === tenantId);
    if (existing) return { ...existing };

    const takenByPerson = new Set(this.snap.connections.filter((c) => c.person === person).map((c) => c.line));
    const tenantLine = this.snap.connections.find((c) => c.tenantId === tenantId)?.line;
    const active = this.snap.lines.filter((l) => l.status === "active");

    let chosen: string | undefined;
    if (tenantLine && !takenByPerson.has(tenantLine) && active.some((l) => l.number === tenantLine)) chosen = tenantLine;
    if (!chosen) {
      const candidates = active
        .filter((l) => !takenByPerson.has(l.number))
        .filter((l) => this.tenantsOn(l.number) < l.maxTenants)
        .sort((a, b) => this.tenantsOn(a.number) / a.maxTenants - this.tenantsOn(b.number) / b.maxTenants);
      chosen = candidates[0]?.number;
    }
    if (!chosen) throw new NoLineAvailableError(`No active line can take ${person} for tenant ${tenantId}; add a line to the pool`);

    const conn: Connection = { person, line: chosen, tenantId, createdAt: this.now().toISOString() };
    this.snap.connections.push(conn);
    this.persist();
    return { ...conn };
  }

  /** Remove one person's access to a tenant (staff leaving, an owner cancelling). */
  disconnect(person: string, tenantId: string): boolean {
    const before = this.snap.connections.length;
    this.snap.connections = this.snap.connections.filter((c) => !(c.person === person && c.tenantId === tenantId));
    const changed = this.snap.connections.length !== before;
    if (changed) this.persist();
    return changed;
  }

  /**
   * Mark a line flagged and move everyone on it. Returns the moved connections with
   * their new lines; the caller tells each person (from a line that may start
   * conversations, or by email) and sends a fresh contact card.
   */
  evacuate(number: string): Connection[] {
    this.setStatus(number, "flagged");
    const affected = this.snap.connections.filter((c) => c.line === number);
    this.snap.connections = this.snap.connections.filter((c) => c.line !== number);
    const moved: Connection[] = [];
    for (const c of affected) {
      const next = this.assign(c.person, c.tenantId);
      const stored = this.snap.connections.find((x) => x.person === next.person && x.tenantId === next.tenantId);
      if (stored) stored.movedFrom = number;
      moved.push({ ...next, movedFrom: number });
    }
    this.persist();
    return moved;
  }

  /** The person texted their new line; the move is complete. */
  confirmMove(person: string, line: string): void {
    const c = this.snap.connections.find((x) => x.person === person && x.line === line);
    if (c?.movedFrom) {
      delete c.movedFrom;
      this.persist();
    }
  }

  private day(): string {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(this.now());
  }

  /** Count messages on a line (inbound and outbound both count toward the daily budget). */
  record(line: string, n = 1): UsageResult {
    const day = this.day();
    const key = `${line}|${day}`;
    const before = this.snap.usage[key] ?? 0;
    const count = before + n;
    this.snap.usage[key] = count;
    // Keep two weeks of history.
    const keep = new Set<string>();
    for (const k of Object.keys(this.snap.usage)) keep.add(k.split("|")[1] ?? "");
    const days = [...keep].sort();
    if (days.length > 14) for (const k of Object.keys(this.snap.usage)) if ((k.split("|")[1] ?? "") < days[days.length - 14]!) delete this.snap.usage[k];
    this.persist();
    const budget = this.snap.lines.find((l) => l.number === line)?.dailyBudget ?? Infinity;
    const threshold = budget * this.alertAt;
    if (before < threshold && count >= threshold) this.onAlert?.(line, count, budget);
    return { line, day, count, budget, ratio: count / budget };
  }

  usage(line: string): UsageResult {
    const day = this.day();
    const count = this.snap.usage[`${line}|${day}`] ?? 0;
    const budget = this.snap.lines.find((l) => l.number === line)?.dailyBudget ?? Infinity;
    return { line, day, count, budget, ratio: count / budget };
  }
}
