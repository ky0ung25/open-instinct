#!/usr/bin/env node
/**
 * Dreaming, end to end, for one small business over two nights.
 *
 *   node examples/dream-demo.mjs [out-dir]
 *
 * With ANTHROPIC_API_KEY set, Claude does the dreaming. Without it, a scripted
 * model replays the plans a dream would produce, so you can see the files, the
 * profile and the git history with no key and no network.
 *
 * Night 1: the owner of a hair salon signs up, shares prices and preferences, and
 *          a customer asks for a wedding quote.
 * Night 2: the owner fixes a price, the website goes live, and a pop-up event is
 *          called off. The dream corrects the fact, completes one workstream and
 *          removes the cancelled one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anthropicDreamModel, logTurn, memoryDigest, runDream, scriptedDreamModel, searchMemory } from "../packages/dream/dist/index.js";

const TZ = "America/New_York";
const root = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "dream-demo-")));
fs.mkdirSync(root, { recursive: true });

const say = (ts, role, text, from) => logTurn(root, { ts, role, text, ...(from ? { from } : {}) }, TZ);

// ---- Day 1, Tuesday 2026-10-20 --------------------------------------------------
say("2026-10-20T13:02:00Z", "owner", "Hi! I run Luna Hair Studio in Park Slope, Brooklyn. My site is lunahair.com but it's old");
say("2026-10-20T13:02:30Z", "assistant", "Nice to meet you! I'm building a new preview from lunahair.com now. Want to keep the same name and colors?");
say("2026-10-20T13:04:00Z", "owner", "Yes keep the name. Women's cut is $45, men's cut $35, color starts at $120. Open Tue to Sat 10 to 7.");
say("2026-10-20T13:06:00Z", "owner", "Please keep texts short, I'm usually with a client. And never reply to a bad review without asking me first.");
say("2026-10-20T13:06:20Z", "assistant", "Got it. Short texts, and I'll always ask before replying to a negative review.");
say("2026-10-20T15:40:00Z", "other", "Hi, this is Mike Chen. Can I get a quote for my wedding party, 6 people, on Nov 14?", "+17185550123");
say("2026-10-20T15:41:00Z", "assistant", "Mike Chen asked for a wedding party quote: 6 people on Nov 14. What should I quote him?");
say("2026-10-20T17:15:00Z", "owner", "Tell Mike $40 a person, and we'll do a pop-up at the Saturday market on Nov 1. My assistant stylist is Priya.");
say("2026-10-20T17:16:00Z", "owner", "Also when I say 'the site' I mean the new one you're building, not lunahair.com");

const night1 = {
  daily: [
    "Owner signed up and shared the old site, lunahair.com",
    "Owner set prices and opening hours",
    "Mike Chen asked for a wedding party quote; owner set $40 a person",
    "Owner planned a pop-up at the Saturday market on Nov 1",
  ],
  operations: [
    { op: "upsert", folder: "entities/orgs", id: "luna-hair-studio", title: "Luna Hair Studio", aliases: ["Luna", "the salon", "lunahair.com"], add: ["Hair salon in Park Slope, Brooklyn", "Old website: lunahair.com; owner wants it replaced", "Open Tuesday to Saturday, 10 AM to 7 PM"] },
    { op: "upsert", folder: "knowledge/facts", id: "prices", title: "Prices", aliases: ["price list", "menu"], add: ["Women's cut: $45", "Men's cut: $35", "Color: from $120", "Wedding parties: $40 per person"], links: ["luna-hair-studio"] },
    { op: "upsert", folder: "knowledge/preferences", id: "how-owner-works", title: "How the owner likes to work", add: ["Keep texts short; owner is usually with a client", "Always ask before replying to a negative review", "'The site' means the new website, not lunahair.com"] },
    { op: "upsert", folder: "entities/people", id: "mike-chen", title: "Mike Chen", aliases: ["Mike"], add: ["Customer, phone +1 718 555 0123", "Wedding on Nov 14, party of 6"], links: ["wedding-quote-mike-chen"] },
    { op: "upsert", folder: "entities/people", id: "priya", title: "Priya", add: ["Assistant stylist at the salon"], links: ["luna-hair-studio"] },
    { op: "upsert", folder: "workstreams/active", id: "wedding-quote-mike-chen", title: "Wedding quote for Mike Chen", add: ["6 people on Nov 14 at $40 each ($240)", "Next: send Mike the quote"], links: ["mike-chen"] },
    { op: "upsert", folder: "workstreams/active", id: "launch-website", title: "Launch the new website", add: ["Preview built from lunahair.com, same name and colors", "Next: owner reviews the preview"], links: ["luna-hair-studio"] },
    { op: "upsert", folder: "workstreams/active", id: "saturday-market-popup", title: "Pop-up at the Saturday market", add: ["Planned for Nov 1"] },
  ],
  profile: `# Luna Hair Studio

## Business
Hair salon in Park Slope, Brooklyn. Open Tuesday to Saturday, 10 AM to 7 PM. Old site lunahair.com is being replaced by a new one.
Prices: women's cut $45, men's cut $35, color from $120, wedding parties $40 a person.

## Owner
Runs the salon day to day, usually with a client.

## How the owner likes to work
- Short texts.
- Ask before replying to any negative review.
- "The site" means the new website.

## Active work
- Launch the new website (owner to review the preview)
- Wedding quote for Mike Chen: 6 people, Nov 14, $240
- Pop-up at the Saturday market, Nov 1

## Key people
- Mike Chen: customer, wedding Nov 14
- Priya: assistant stylist`,
};

// ---- Day 2, Wednesday 2026-10-21 ------------------------------------------------
const day2 = () => {
  say("2026-10-21T14:10:00Z", "owner", "Oops, women's cut is actually $55 now, not $45. Raised it last month.");
  say("2026-10-21T14:10:30Z", "assistant", "Updated to $55 on the site.");
  say("2026-10-21T16:30:00Z", "owner", "The site looks great, let's go live!");
  say("2026-10-21T16:31:00Z", "assistant", "It's live at lunahair.smbassistant.com.");
  say("2026-10-21T18:00:00Z", "owner", "Scratch the market pop-up, it's not happening. Did you send Mike his quote?");
  say("2026-10-21T18:00:40Z", "assistant", "Not yet. Sending it now: 6 people at $40 each, $240 total.");
  say("2026-10-21T20:05:00Z", "other", "Thanks! $240 works, book us for 9am Nov 14.", "+17185550123");
};

const night2 = {
  daily: [
    "Owner corrected the women's cut price to $55",
    "New website went live",
    "Owner cancelled the Saturday market pop-up",
    "Mike Chen accepted the $240 quote and booked 9 AM on Nov 14",
  ],
  operations: [
    { op: "correct", folder: "knowledge/facts", id: "prices", old: "Women's cut: $45", new: "Women's cut: $55" },
    { op: "complete", id: "launch-website", note: "live on the free subdomain" },
    { op: "delete", folder: "workstreams/active", id: "saturday-market-popup", reason: "owner said it is not happening" },
    { op: "complete", id: "wedding-quote-mike-chen", note: "Mike accepted $240" },
    { op: "upsert", folder: "entities/people", id: "mike-chen", add: ["Booked 9 AM on Nov 14 for his wedding party"], remove: ["Wedding on Nov 14, party of 6"] },
    { op: "upsert", folder: "knowledge/decisions", id: "website-domain", title: "Website domain", add: ["New site runs on the free subdomain for now"], links: ["luna-hair-studio"] },
  ],
  profile: `# Luna Hair Studio

## Business
Hair salon in Park Slope, Brooklyn. Open Tuesday to Saturday, 10 AM to 7 PM. New website is live on the free subdomain.
Prices: women's cut $55, men's cut $35, color from $120, wedding parties $40 a person.

## Owner
Runs the salon day to day, usually with a client.

## How the owner likes to work
- Short texts.
- Ask before replying to any negative review.
- "The site" means the new website.

## Active work
- Nothing open right now.

## Key people
- Mike Chen: customer, wedding party booked 9 AM Nov 14
- Priya: assistant stylist`,
};

const live = Boolean(process.env.ANTHROPIC_API_KEY);
const model = live ? anthropicDreamModel({ apiKey: process.env.ANTHROPIC_API_KEY }) : scriptedDreamModel([night1, night2]);

console.log(`memory root: ${root}`);
console.log(live ? "dreaming with Claude\n" : "dreaming with the scripted model (set ANTHROPIC_API_KEY to use Claude)\n");

const r1 = await runDream({ root, model, timeZone: TZ, now: new Date("2026-10-21T07:00:00Z") });
console.log(`night 1 (${r1.day}): ${r1.turns} turns, +${r1.created.length} files, commit ${r1.commit}`);

day2();
console.log("\nbefore night 2, the assistant's prompt carries the profile plus what was said today:");
console.log(indent(memoryDigest(root).split("(not in memory yet)")[1]?.trim() ?? "", "  "));

const r2 = await runDream({ root, model, timeZone: TZ, now: new Date("2026-10-22T07:00:00Z") });
console.log(`\nnight 2 (${r2.day}): ${r2.turns} turns, corrected ${r2.corrected.join(", ")}; done ${r2.completed.join(", ")}; removed ${r2.deleted.join(", ")}`);
for (const w of [...r1.warnings, ...r2.warnings]) console.log(`  warning: ${w}`);

console.log("\nPROFILE.md");
console.log(indent(fs.readFileSync(path.join(root, "PROFILE.md"), "utf8"), "  "));
console.log("knowledge/facts/prices.md");
console.log(indent(fs.readFileSync(path.join(root, "knowledge/facts/prices.md"), "utf8"), "  "));
console.log(`search "wedding": ${searchMemory(root, "wedding").map((h) => `${h.folder}/${h.id}`).join(", ")}`);
console.log("\ngit log");
console.log(indent(execFileSync("git", ["-C", root, "log", "--stat", "--format=%n%h %s%n%b"], { encoding: "utf8" }).trim(), "  "));

function indent(text, pad) {
  return text.split("\n").map((l) => pad + l).join("\n");
}
