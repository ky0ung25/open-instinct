#!/usr/bin/env node
/**
 * instinct-dream --root <memory dir> [--tz America/New_York] [--model claude-sonnet-5-5] [--dry-run]
 *
 * Runs one dream and prints the report as JSON. Meant for system cron. Needs ANTHROPIC_API_KEY.
 */
import { runDream } from "./dream.js";
import { anthropicDreamModel } from "./model.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const root = arg("root");
  if (!root) throw new Error("usage: instinct-dream --root <memory dir> [--tz <zone>] [--model <id>] [--dry-run]");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const modelId = arg("model");
  const report = await runDream({
    root,
    timeZone: arg("tz") ?? process.env.TZ ?? "UTC",
    model: anthropicDreamModel(modelId ? { apiKey, model: modelId } : { apiKey }),
    dryRun: process.argv.includes("--dry-run"),
  });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
