import { describe, expect, it } from "vitest";
import {
  LinePool,
  NoLineAvailableError,
  SendblueChannel,
  SendblueHttpError,
  directKey,
  groupKey,
  isOptOut,
  parseSendblueEvent,
  parseSendblueKey,
  verifySendblueSecret,
} from "../src/index.js";

const LINE_A = "+15125550100";
const LINE_B = "+15125550200";
const SAM = "+14155550199";

function fakeFetch(responses: Array<{ status?: number; body: unknown }> = []) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { body: { status: "QUEUED", message_handle: "h1" } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const principal = undefined as never;

describe("keys", () => {
  it("round-trips direct and group keys", () => {
    expect(parseSendblueKey(directKey("imessage", LINE_A, SAM))).toEqual({ channel: "imessage", line: LINE_A, remote: SAM });
    expect(parseSendblueKey(groupKey("g-1", LINE_A))).toEqual({ channel: "imessage", groupId: "g-1", line: LINE_A });
    expect(parseSendblueKey("email:abc")).toBeUndefined();
  });
});

describe("parseSendblueEvent", () => {
  const inbound = {
    content: "We're closed Monday",
    is_outbound: false,
    status: "RECEIVED",
    message_handle: "99DC",
    date_sent: "2026-10-19T15:41:20.932Z",
    from_number: SAM,
    number: SAM,
    to_number: LINE_A,
    sendblue_number: LINE_A,
    service: "iMessage",
    group_id: "",
    participants: [SAM, LINE_A],
    media_url: "",
    opted_out: false,
  };

  it("keys a 1:1 message by line and sender", () => {
    const msg = parseSendblueEvent(inbound)!;
    expect(msg.conversationKey).toBe(directKey("imessage", LINE_A, SAM));
    expect(msg.from).toBe(SAM);
    expect(msg.replyRef.line).toBe(LINE_A);
    expect(msg.id).toBe("sendblue:99DC");
  });

  it("ignores outbound echoes", () => {
    expect(parseSendblueEvent({ ...inbound, is_outbound: true, status: "SENT" })).toBeUndefined();
  });

  it("marks SMS fallbacks and groups", () => {
    expect(parseSendblueEvent({ ...inbound, service: "SMS" })!.channel).toBe("sms");
    expect(parseSendblueEvent({ ...inbound, group_id: "g-9" })!.conversationKey).toBe(groupKey("g-9", LINE_A));
  });

  it("carries media and detects opt-outs", () => {
    const m = parseSendblueEvent({ ...inbound, content: "", media_url: "https://cdn.example/a.jpg" })!;
    expect(m.text).toBe("[attachment]");
    expect(m.attachments).toEqual([{ url: "https://cdn.example/a.jpg" }]);
    expect(isOptOut(parseSendblueEvent({ ...inbound, content: "STOP" })!)).toBe(true);
  });
});

describe("verifySendblueSecret", () => {
  it("accepts only the configured secret", () => {
    expect(verifySendblueSecret({ "sb-signing-secret": "s3cret" }, "s3cret")).toBe(true);
    expect(verifySendblueSecret({ "SB-Signing-Secret": "s3cret" }, "s3cret")).toBe(true);
    expect(verifySendblueSecret({ "sb-signing-secret": "nope" }, "s3cret")).toBe(false);
    expect(verifySendblueSecret({}, undefined)).toBe(false);
  });
});

describe("SendblueChannel", () => {
  it("replies from the line in the conversation key", async () => {
    const f = fakeFetch();
    const sent: string[] = [];
    const ch = new SendblueChannel({ apiKeyId: "k", apiSecret: "s", fetchImpl: f.impl, onSent: (l) => sent.push(l) });
    await ch.send({ channel: "imessage", conversationKey: directKey("imessage", LINE_B, SAM), text: "Done, hours updated." }, { principal, conversationKey: "" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.sendblue.com/api/send-message");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body).toMatchObject({ number: SAM, from_number: LINE_B, content: "Done, hours updated." });
    expect((f.calls[0]!.init.headers as Record<string, string>)["sb-api-key-id"]).toBe("k");
    expect(sent).toEqual([LINE_B]);
  });

  it("sends media then text as separate bubbles and splits long text", async () => {
    const f = fakeFetch();
    const ch = new SendblueChannel({ apiKeyId: "k", apiSecret: "s", fetchImpl: f.impl });
    const long = `${"a".repeat(1000)}. ${"b".repeat(1000)}.`;
    await ch.send({ channel: "imessage", conversationKey: directKey("imessage", LINE_A, SAM), text: long, mediaUrls: ["https://x/p.png"] }, { principal, conversationKey: "" });
    expect(f.calls).toHaveLength(3);
    expect(JSON.parse(String(f.calls[0]!.init.body)).media_url).toBe("https://x/p.png");
  });

  it("surfaces line-limit errors", async () => {
    const f = fakeFetch([{ status: 400, body: { status: "ERROR", error_code: 429, error_key: "LINE_DAILY_LIMIT_REACHED", message: "limit" } }]);
    const ch = new SendblueChannel({ apiKeyId: "k", apiSecret: "s", fetchImpl: f.impl });
    const err = await ch.send({ channel: "imessage", conversationKey: directKey("imessage", LINE_A, SAM), text: "hi" }, { principal, conversationKey: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(SendblueHttpError);
    expect((err as SendblueHttpError).isLineLimit).toBe(true);
  });
});

describe("LinePool", () => {
  it("spreads tenants across lines by load", () => {
    const pool = new LinePool();
    pool.addLine(LINE_A, { maxTenants: 2 });
    pool.addLine(LINE_B, { maxTenants: 2 });
    const a = pool.assign("+11111111111", "luna-salon");
    const b = pool.assign("+12222222222", "joes-plumbing");
    expect(new Set([a.line, b.line]).size).toBe(2);
    expect(pool.resolve("+11111111111", a.line)?.tenantId).toBe("luna-salon");
  });

  it("never puts two tenants for one person on the same line", () => {
    const pool = new LinePool();
    pool.addLine(LINE_A);
    pool.addLine(LINE_B);
    const first = pool.assign(SAM, "salon");
    const second = pool.assign(SAM, "spa");
    expect(first.line).not.toBe(second.line);
    pool.setStatus(LINE_B, "retired");
    expect(() => pool.assign(SAM, "third-business")).toThrow(NoLineAvailableError);
  });

  it("puts staff on the tenant's existing line", () => {
    const pool = new LinePool();
    pool.addLine(LINE_A);
    pool.addLine(LINE_B);
    const owner = pool.assign(SAM, "salon");
    const staff = pool.assign("+13333333333", "salon");
    expect(staff.line).toBe(owner.line);
  });

  it("evacuates a flagged line", () => {
    const pool = new LinePool();
    pool.addLine(LINE_A);
    const c = pool.assign(SAM, "salon");
    pool.addLine(LINE_B);
    const moved = pool.evacuate(c.line);
    expect(moved).toEqual([expect.objectContaining({ person: SAM, tenantId: "salon", line: LINE_B, movedFrom: LINE_A })]);
    expect(pool.resolve(SAM, LINE_A)).toBeUndefined();
    pool.confirmMove(SAM, LINE_B);
    expect(pool.resolve(SAM, LINE_B)?.movedFrom).toBeUndefined();
  });

  it("alerts once when a line crosses 70% of its daily budget", () => {
    const alerts: number[] = [];
    const pool = new LinePool({ onAlert: (_l, count) => alerts.push(count) });
    pool.addLine(LINE_A, { dailyBudget: 10 });
    for (let i = 0; i < 9; i++) pool.record(LINE_A);
    expect(alerts).toEqual([7]);
    expect(pool.usage(LINE_A).count).toBe(9);
  });
});
