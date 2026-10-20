# @open-instinct/sendblue

Sendblue adapter for Open Instinct. A drop-in for the Outbox role that `@open-instinct/inkbox` plays, plus the shared line pool that lets many owners text a few Sendblue lines.

## Pieces

| Export | What it does |
|---|---|
| `SendblueClient` | REST calls: send, group send, typing, tapbacks, read receipts, file upload, iMessage lookup, list lines |
| `SendblueChannel` | `Outbox` implementation. Replies always leave on the line in the conversation key |
| `parseSendblueEvent` | `receive` webhook → `InboundMessage`. Skips outbound echoes and status callbacks |
| `verifySendblueSecret` | Constant-time check of the `sb-signing-secret` header |
| `LinePool` | Home-line assignment, (person, line) → tenant routing, daily usage counts, moving owners off a flagged line |

## Conversation keys

Sendblue has no conversation id, so the key is the pair (our line, their number):

```
imessage:+15125550100/+14155550199
sms:+15125550100/+14155550199
imessage:group/<group_id>@+15125550100
```

## The pool rule

A person can have only one tenant (business) per line. Their phone shows one thread per number, so two tenants on one line would merge. `LinePool.assign` enforces this and otherwise picks the least-loaded active line. Staff of a business join the owner's line.

Defaults: 400 tenants and 3,000 messages a day per line, with an alert at 70%. Tune after a pilot.

## Wiring sketch

```ts
const pool = new LinePool({ store: new FilePoolStore(state.path("sendblue-pool.json")), onAlert: notifyOps });
const outbox = new SendblueChannel({ apiKeyId, apiSecret, onSent: (line) => pool.record(line) });

// POST /webhooks/sendblue
if (!verifySendblueSecret(req.headers, process.env.SENDBLUE_SIGNING_SECRET)) return 401;
const msg = parseSendblueEvent(JSON.parse(raw));
if (!msg) return 200;
pool.record(msg.replyRef.line!);
const conn = pool.resolve(msg.from, msg.replyRef.line!);
if (!conn) return replyWithSignupLink(msg);   // unknown sender on this line
pool.confirmMove(conn.person, conn.line);
await runtimeFor(conn.tenantId).handle(msg);
```

## Environment

`SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET`, `SENDBLUE_SIGNING_SECRET`.

## Not done yet

- `/webhooks/sendblue` route in `packages/server` and per-tenant routing in `packages/gateway`
- Phone verification at signup (SMS code through a separate SMS provider, not the iMessage lines)
- Sending the move notice after `LinePool.evacuate` (needs a line that may start conversations, or email)
