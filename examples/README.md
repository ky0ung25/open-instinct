# Examples

Four small scripts that run the pieces without a phone, a VM or an account. Each is plain
Node (22.19 or newer), one file, no extra dependencies. Build once first:

```bash
pnpm install && pnpm build
```

| Script | What it shows | Needs |
|---|---|---|
| [local-chat.mjs](local-chat.mjs) | A chat loop against a running agent over `POST /chat` | a running server (`pnpm instinct dev`) and a model key |
| [fake-inkbox-webhook.mjs](fake-inkbox-webhook.mjs) | A signed `imessage.received` webhook, exactly as Inkbox would send it, and a tampered one that is refused | a running server started with `INKBOX_SIGNING_KEY` |
| [dinner-a2a.mjs](dinner-a2a.mjs) | Two real agents planning a dinner over A2A with the model and the transport stubbed | nothing: no keys, no network |
| [dream-demo.mjs](dream-demo.mjs) | Two nights of "dreaming" memory for a hair salon: facts, a correction, finished and cancelled work, a git commit per night. Output: [dream-sample/](dream-sample) | nothing; `ANTHROPIC_API_KEY` makes Claude do the dreaming |

## 1. Chat loop

Start the agent in one terminal:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm instinct init --name "Maria" --phone +14155550100 --email maria@example.com --handle maria-instinct
pnpm instinct dev
```

In another:

```bash
node examples/local-chat.mjs
```

```
Instinct (model anthropic/claude-fable-5-1, computer none) on http://127.0.0.1:8080
conversation local-3f9a1c2e. Type a message. Ctrl-D or "quit" to leave.

you> remember that I like window seats
agent> Noted: window seats from now on.
```

Every line is one `POST /chat` with the same `conversation_id`, so the agent keeps context. If a reply
takes longer than the server's budget, the server answers with an acknowledgement and the finished text
comes back on your next line, marked `(earlier)`. When the server was started with `INSTINCT_CHAT_TOKEN`,
export the same value before running the script; it is sent as a Bearer token. Pass another base URL as
the first argument to talk to a server on a different port. This is the same call `pnpm instinct chat`
makes once.

## 2. Signed fake Inkbox webhook

Inkbox signs each webhook with HMAC-SHA256 over `<request id>.<timestamp>.<raw body>` and sends the
result as `X-Inkbox-Signature: sha256=<hex>`. The server verifies that before it parses anything. This
script builds the same signature, so you can drive the iMessage path without Inkbox.

Start the server with a signing key (any string works locally):

```bash
INKBOX_SIGNING_KEY=whsec_local_test pnpm instinct dev
```

Without an Inkbox API key the agent still runs. Its iMessage replies go to the console outbox, so watch
the server's terminal.

```bash
# a stranger texts the agent
INKBOX_SIGNING_KEY=whsec_local_test node examples/fake-inkbox-webhook.mjs --text "hi, who is this?"

# the owner texts (use the phone you gave to `instinct init`)
INKBOX_SIGNING_KEY=whsec_local_test node examples/fake-inkbox-webhook.mjs --from +14155550100 --text "remember I like window seats"

# a body changed after signing is refused
INKBOX_SIGNING_KEY=whsec_local_test node examples/fake-inkbox-webhook.mjs --tamper
```

Expected: `HTTP 204` for the first two, and `HTTP 401 {"error":"invalid signature"}` for the third. The
script exits non-zero when it gets anything else. A server started without a signing key answers `503`.

Flags: `--url` (default `http://127.0.0.1:8080`), `--from`, `--text`, `--conversation`, `--key`, `--tamper`.
The event shape matches what `parseInkboxEvent` in `@open-instinct/inkbox` expects; the signature
construction matches its `computeInkboxSignature`.

## 3. Two agents plan a dinner over A2A

```bash
node examples/dinner-a2a.mjs
```

Maria and Sam are partners. Each has an Open Instinct booted with the real server code (`boot` from
`@open-instinct/server`), a real policy engine, real contacts, a real audit log. Two things are stubbed:

| Stubbed | With |
|---|---|
| The model | Pi's faux provider, playing back scripted tool calls and replies |
| Inkbox | A fake `fetch`. A JSON-RPC `SendMessage` to `https://inkbox.ai/a2a/<peer>` becomes an `a2a.task.created` webhook on the peer. A REST reply on a task becomes an `a2a.sent_task.updated` webhook on the caller |

The flow is the one in [docs/PROTOCOL.md](../docs/PROTOCOL.md):

```
1. Maria asks her agent
  wire  @maria-instinct -> @sam-instinct  SendMessage  task_1 in ctx_1
  chat  Maria's Instinct -> Maria: Asked Sam's Instinct about Thursday or Friday near the Mission. I will tell you when it answers.
  imessage @sam-instinct -> +14155550199: Maria's agent (@maria-instinct) via Sam's Instinct: Maria's Instinct asked about dinner ...
  wire  @sam-instinct -> @maria-instinct  reply complete  task_1
  imessage @maria-instinct -> +14155550100: Sam's agent (@sam-instinct) via Maria's Instinct: Sam is in for Thursday Oct 8 at 7 pm ...
2. Maria says yes; her agent confirms in the same context
  wire  @maria-instinct -> @sam-instinct  SendMessage  task_2 in ctx_1
  ...
3. What each audit log says
  ok   Sam's agent resolved the caller to agent:maria-instinct (partner)
  ok   policy allowed only notify_owner and reply_instinct for Maria's agent

dinner planned
```

What to look at:

- `propose_times` goes out with an OIP/1 data part; Sam's agent answers with a typed `accept`.
- Sam's agent resolves the caller handle to Sam's contact "Maria" at tier `partner`, so the policy lets
  it do exactly two things: tell Sam (`notify_owner`) and answer the task (`reply_instinct`).
- Each owner gets a text through their own agent, prefixed with who asked. Nobody is booked without a yes.
- The `confirm` reuses `ctx_1`, so both audit logs hold one conversation for the whole dinner.

The script exits non-zero if any step in that chain is missing. Read the source for the scripted
responses; swapping the faux provider for a real model is a one-line change in `startAgent`.

## Writing your own

- To drive a running agent, speak to its HTTP surface: `GET /`, `POST /chat`, `GET /schedules`, with
  `Authorization: Bearer <INSTINCT_CHAT_TOKEN>` when the server has one. Routes are listed in
  [packages/server/README.md](../packages/server/README.md).
- To embed an agent in your own process, call `boot(env, { model, streamFn, outbox, fetchImpl })` and
  feed `app.runtime.handleInbound(message)` the `InboundMessage` shape from `@open-instinct/core`.
  `dinner-a2a.mjs` does both.
- The faux provider (`fauxProvider`, `fauxAssistantMessage`, `fauxToolCall` from
  `@earendil-works/pi-ai`) is how the smoke test and these examples run without a key.
