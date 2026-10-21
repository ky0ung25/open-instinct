import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dreamHistory,
  isoWeek,
  listFiles,
  logTurn,
  looksSecret,
  memoryDigest,
  nextLocalTime,
  runDream,
  scriptedDreamModel,
  searchMemory,
  validatePlan,
} from "../src/index.js";

const roots: string[] = [];
function tmp(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "dream-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const TZ = "America/New_York";

function night1(root: string) {
  logTurn(root, { ts: "2026-10-20T14:00:00Z", role: "owner", text: "Hi! I run Luna Hair Studio in Brooklyn. Site is lunahair.com" }, TZ);
  logTurn(root, { ts: "2026-10-20T14:00:20Z", role: "assistant", text: "Nice to meet you! Building your preview now." }, TZ);
  logTurn(root, { ts: "2026-10-20T14:05:00Z", role: "owner", text: "Women's cut is $45. Keep replies short please. Never answer a bad review without asking me." }, TZ);
  logTurn(root, { ts: "2026-10-20T15:00:00Z", role: "other", from: "+17185550123", text: "Hi it's Mike Chen, can I get a quote for a wedding party of 6?" }, TZ);
}

const plan1 = {
  daily: ["Owner signed up and shared lunahair.com", "Mike Chen asked for a wedding party quote"],
  operations: [
    { op: "upsert", folder: "entities/orgs", id: "luna-hair-studio", title: "Luna Hair Studio", aliases: ["Luna", "lunahair.com"], add: ["Hair salon in Brooklyn", "Website: lunahair.com"] },
    { op: "upsert", folder: "knowledge/facts", id: "prices", title: "Prices", add: ["Women's cut is $45"], links: ["luna-hair-studio"] },
    { op: "upsert", folder: "knowledge/preferences", id: "communication", title: "How the owner likes to work", add: ["Keep replies short", "Ask before replying to any negative review"] },
    { op: "upsert", folder: "entities/people", id: "mike-chen", title: "Mike Chen", aliases: ["Mike"], add: ["Customer; phone +1 718 555 0123", "Planning a wedding, party of 6"] },
    { op: "upsert", folder: "workstreams/active", id: "wedding-quote-mike", title: "Wedding quote for Mike Chen", add: ["Party of 6; owner to set the price"], links: ["mike-chen"] },
    { op: "upsert", folder: "workstreams/active", id: "launch-website", title: "Launch website", add: ["Preview built from lunahair.com"] },
  ],
  profile: "# Luna Hair Studio\n\n## Business\nHair salon in Brooklyn. lunahair.com.\n\n## How the owner likes to work\nShort replies. Ask before replying to negative reviews.\n\n## Active work\n- Launch website\n- Wedding quote for Mike Chen",
};

describe("runDream", () => {
  it("builds the tree, profile, timeline and a commit from one night", async () => {
    const root = tmp();
    night1(root);
    const model = scriptedDreamModel([plan1]);
    const r = await runDream({ root, model, timeZone: TZ, now: new Date("2026-10-21T07:00:00Z") });
    expect(r.day).toBe("2026-10-20");
    expect(r.turns).toBe(4);
    expect(r.created).toHaveLength(6);
    expect(r.commit).toBeTruthy();
    expect(fs.readFileSync(path.join(root, "PROFILE.md"), "utf8")).toContain("Luna Hair Studio");
    expect(fs.readFileSync(path.join(root, "timeline/daily/2026-10-20.md"), "utf8")).toContain("- Owner signed up");
    const prices = fs.readFileSync(path.join(root, "knowledge/facts/prices.md"), "utf8");
    expect(prices).toContain("- Women's cut is $45 (2026-10-20)");
    expect(prices).toContain("[[luna-hair-studio]]");
    expect(model.prompts[0]).toContain("owner: Women's cut is $45");
    expect(dreamHistory(root)[0]).toMatch(/dream 2026-10-20: \+6 new/);
  });

  it("does nothing on a night with no new turns", async () => {
    const root = tmp();
    night1(root);
    const model = scriptedDreamModel([plan1]);
    await runDream({ root, model, timeZone: TZ });
    const again = await runDream({ root, model, timeZone: TZ });
    expect(again.skipped).toBeTruthy();
    expect(model.prompts).toHaveLength(1);
  });

  it("corrects, completes and deletes on the second night, and shows only touched files in full", async () => {
    const root = tmp();
    night1(root);
    await runDream({ root, model: scriptedDreamModel([plan1]), timeZone: TZ });
    logTurn(root, { ts: "2026-10-21T16:00:00Z", role: "owner", text: "Oops, women's cut is $55 not $45. Website looks great, it's live!" }, TZ);
    const model = scriptedDreamModel([
      {
        daily: ["Owner fixed the women's cut price", "Website went live"],
        operations: [
          { op: "correct", folder: "knowledge/facts", id: "prices", old: "Women's cut is $45", new: "Women's cut is $55" },
          { op: "complete", id: "launch-website", note: "live on the free subdomain" },
          { op: "delete", folder: "entities/people", id: "nobody", reason: "never existed" },
        ],
        profile: "# Luna Hair Studio\n\nWomen's cut $55.",
      },
    ]);
    const r = await runDream({ root, model, timeZone: TZ });
    expect(r.corrected).toEqual(["prices"]);
    expect(r.completed).toEqual(["launch-website"]);
    const prices = fs.readFileSync(path.join(root, "knowledge/facts/prices.md"), "utf8");
    expect(prices).toContain("Women's cut is $55 (corrected 2026-10-21)");
    expect(prices).not.toContain("$45");
    expect(fs.existsSync(path.join(root, "workstreams/completed/launch-website.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "workstreams/active/launch-website.md"))).toBe(false);
    // Mike was not mentioned tonight: his file is in the index but not shown in full.
    const prompt = model.prompts[0]!;
    expect(prompt).toContain("- mike-chen | entities/people | Mike Chen");
    expect(prompt).not.toContain("### entities/people/mike-chen.md");
    expect(prompt).toContain("### knowledge/facts/prices.md");
    expect(dreamHistory(root)).toHaveLength(2);
  });

  it("writes a weekly rollup on Sundays", async () => {
    const root = tmp();
    logTurn(root, { ts: "2026-10-25T15:00:00Z", role: "owner", text: "Slow Sunday." }, TZ);
    const model = scriptedDreamModel([{ daily: ["Quiet day"], operations: [], profile: "# Luna", weekly: ["Signed up", "Site went live"] }]);
    const r = await runDream({ root, model, timeZone: TZ });
    expect(r.weekly).toBe(isoWeek("2026-10-25"));
    expect(fs.readFileSync(path.join(root, `timeline/weekly/${r.weekly}.md`), "utf8")).toContain("- Site went live");
    expect(model.prompts[0]).toContain("Also fill \"weekly\"");
  });

  it("dry run writes nothing", async () => {
    const root = tmp();
    night1(root);
    const r = await runDream({ root, model: scriptedDreamModel([plan1]), timeZone: TZ, dryRun: true });
    expect(r.plan?.operations).toHaveLength(6);
    expect(listFiles(root)).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "PROFILE.md"))).toBe(false);
  });
});

describe("validatePlan", () => {
  it("drops secrets, bad ids, bad folders and path tricks", () => {
    const { plan, warnings } = validatePlan({
      daily: ["Paid with card 4242 4242 4242 4242"],
      operations: [
        { op: "upsert", folder: "../../etc", id: "x", add: ["a"] },
        { op: "upsert", folder: "knowledge/facts", id: "../escape", add: ["a"] },
        { op: "upsert", folder: "knowledge/facts", id: "wifi", add: ["Wifi password is hunter2", "Guest wifi is LunaGuest"] },
        { op: "upsert", folder: "workstreams/completed", id: "sneaky", add: ["a"] },
      ],
      profile: "ok",
    });
    expect(plan.daily).toEqual([]);
    expect(plan.operations).toEqual([{ op: "upsert", folder: "knowledge/facts", id: "wifi", add: ["Guest wifi is LunaGuest"] }]);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(looksSecret("your code is 482913")).toBe(true);
  });
});

describe("read side", () => {
  it("digest is the profile plus what was said since the dream; search matches aliases", async () => {
    const root = tmp();
    night1(root);
    await runDream({ root, model: scriptedDreamModel([plan1]), timeZone: TZ });
    logTurn(root, { ts: "2026-10-21T13:00:00Z", role: "owner", text: "We're closed Monday" }, TZ);
    const digest = memoryDigest(root);
    expect(digest).toContain("# Luna Hair Studio");
    expect(digest).toContain("- owner: We're closed Monday");
    expect(digest).not.toContain("Women's cut is $45. Keep");
    expect(searchMemory(root, "lunahair")[0]?.id).toBe("luna-hair-studio");
    expect(searchMemory(root, "Mike").map((h) => h.id)).toContain("mike-chen");
  });
});

describe("time", () => {
  it("finds the next 3 AM in the owner's zone", () => {
    const next = nextLocalTime(new Date("2026-10-21T12:00:00Z"), 3, 0, TZ);
    expect(next.toISOString()).toBe("2026-10-22T07:00:00.000Z");
  });
});
