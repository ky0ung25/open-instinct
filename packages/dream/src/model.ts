/**
 * The model behind a dream. Anything that takes a system prompt, a user prompt and
 * a JSON schema and returns an object can dream: a real model, or a scripted one
 * in tests and demos.
 */
import { PLAN_SCHEMA } from "./plan.js";

export type DreamModel = (input: { system: string; user: string; schema: typeof PLAN_SCHEMA }) => Promise<unknown>;

export interface AnthropicDreamOptions {
  apiKey: string;
  /** A strong model pays off here: one call a night per business. */
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Claude through the Messages API, with the plan forced as a tool call so the reply is always JSON. */
export function anthropicDreamModel(opts: AnthropicDreamOptions): DreamModel {
  const base = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  return async ({ system, user, schema }) => {
    const res = await doFetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: opts.model ?? "claude-sonnet-5-5",
        max_tokens: opts.maxTokens ?? 8000,
        system,
        messages: [{ role: "user", content: user }],
        tools: [{ name: "save_dream", description: "Save tonight's memory update.", input_schema: schema }],
        tool_choice: { type: "tool", name: "save_dream" },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { content?: Array<{ type: string; name?: string; input?: unknown }>; error?: { message?: string } };
    if (!res.ok) throw new Error(`dream model ${res.status}: ${body.error?.message ?? "request failed"}`);
    const call = body.content?.find((c) => c.type === "tool_use" && c.name === "save_dream");
    if (!call) throw new Error("dream model returned no save_dream call");
    return call.input;
  };
}

/** Returns canned plans in order. For tests and offline demos. */
export function scriptedDreamModel(plans: unknown[]): DreamModel & { prompts: string[] } {
  const queue = [...plans];
  const prompts: string[] = [];
  const run: DreamModel = async ({ user }) => {
    prompts.push(user);
    if (queue.length === 0) throw new Error("scripted dream model ran out of plans");
    return queue.shift();
  };
  const fn = Object.assign(run, { prompts });
  return fn;
}
