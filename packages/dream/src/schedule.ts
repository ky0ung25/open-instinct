/**
 * Run dreams every night at a local hour, one business after another. Use this in
 * a long-lived process, or skip it and call the CLI from system cron instead:
 *
 *   0 3 * * *  instinct-dream --root /data/tenants/luna-salon/memory --tz America/New_York
 */
import { runDream, type DreamReport } from "./dream.js";
import type { DreamModel } from "./model.js";
import { nextLocalTime } from "./time.js";

export interface Tenant {
  id: string;
  root: string;
  timeZone: string;
}

export interface DreamLoopOptions {
  tenants: () => Tenant[] | Promise<Tenant[]>;
  model: DreamModel;
  /** Local hour to dream at. 3 AM: the day is over and the owner is asleep. */
  hour?: number;
  minute?: number;
  /** The zone the loop wakes up in; each tenant still dates its files in its own zone. */
  timeZone?: string;
  onReport?: (tenant: Tenant, report: DreamReport) => void;
  onError?: (tenant: Tenant, err: unknown) => void;
}

export function startDreamLoop(opts: DreamLoopOptions): { stop: () => void; nextRun: () => Date } {
  let timer: NodeJS.Timeout | undefined;
  let next = nextLocalTime(new Date(), opts.hour ?? 3, opts.minute ?? 0, opts.timeZone ?? "UTC");
  let stopped = false;

  const tick = async () => {
    for (const t of await opts.tenants()) {
      try {
        opts.onReport?.(t, await runDream({ root: t.root, timeZone: t.timeZone, model: opts.model }));
      } catch (err) {
        // One bad night for one business never blocks the rest.
        opts.onError?.(t, err);
      }
    }
    schedule();
  };
  const schedule = () => {
    if (stopped) return;
    next = nextLocalTime(new Date(), opts.hour ?? 3, opts.minute ?? 0, opts.timeZone ?? "UTC");
    timer = setTimeout(() => void tick(), Math.max(1000, next.getTime() - Date.now()));
  };
  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    nextRun: () => next,
  };
}
