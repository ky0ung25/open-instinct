/**
 * A thin REST client for the Sendblue API. Every call sends the two auth headers
 * Sendblue requires; nothing here runs in a browser (Sendblue blocks that).
 * Wire shapes follow docs.sendblue.com as of October 2026 and are read defensively.
 */

export const SENDBLUE_BASE_URL = "https://api.sendblue.com";

export interface SendblueClientOptions {
  apiKeyId: string;
  apiSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Thrown on any non-2xx reply, or a 2xx whose body says `status: "ERROR"`. */
export class SendblueHttpError extends Error {
  readonly status: number;
  /** Sendblue's error_key, e.g. LINE_DAILY_LIMIT_REACHED or LINE_HOURLY_LIMIT_REACHED. */
  readonly errorKey: string | undefined;
  readonly body: unknown;
  constructor(status: number, message: string, errorKey: string | undefined, body: unknown) {
    super(message);
    this.name = "SendblueHttpError";
    this.status = status;
    this.errorKey = errorKey;
    this.body = body;
  }
  /** True when every eligible line has hit a contact cap; retrying now will not help. */
  get isLineLimit(): boolean {
    return this.errorKey === "LINE_DAILY_LIMIT_REACHED" || this.errorKey === "LINE_HOURLY_LIMIT_REACHED";
  }
  /** True for rate limits and server errors worth a later retry. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface SendMessageInput {
  /** Recipient, E.164. */
  number: string;
  /** The Sendblue line to send from, E.164. Always set it: replies must leave on the owner's home line. */
  fromNumber: string;
  content?: string;
  mediaUrl?: string;
  sendStyle?: string;
  replyToMessageHandle?: string;
  statusCallback?: string;
}

export interface SendGroupMessageInput {
  groupId?: string;
  numbers?: string[];
  fromNumber: string;
  content?: string;
  mediaUrl?: string;
  replyToMessageHandle?: string;
}

export interface SentMessage {
  messageHandle?: string;
  status?: string;
  fromNumber?: string;
  service?: string;
  groupId?: string;
}

type Dict = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export class SendblueClient {
  private readonly opts: SendblueClientOptions;
  private readonly base: string;

  constructor(opts: SendblueClientOptions) {
    if (!opts.apiKeyId || !opts.apiSecret) throw new Error("SendblueClient needs apiKeyId and apiSecret");
    this.opts = opts;
    this.base = (opts.baseUrl ?? SENDBLUE_BASE_URL).replace(/\/+$/, "");
  }

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? globalThis.fetch;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { "sb-api-key-id": this.opts.apiKeyId, "sb-api-secret-key": this.opts.apiSecret };
    if (json) h["content-type"] = "application/json";
    return h;
  }

  async request<T = Dict>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: this.headers(body !== undefined) };
    if (body !== undefined) init.body = JSON.stringify(body);
    return this.handle<T>(await this.fetch(`${this.base}${path}`, init));
  }

  private async handle<T>(res: Response): Promise<T> {
    const raw = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = raw;
    }
    const d = (parsed && typeof parsed === "object" ? parsed : {}) as Dict;
    const bodyError = d.status === "ERROR";
    if (!res.ok || bodyError) {
      const message = str(d.message) ?? str(d.error_message) ?? str(d.error) ?? `Sendblue ${res.status}`;
      throw new SendblueHttpError(res.status, message, str(d.error_key), parsed);
    }
    return parsed as T;
  }

  async sendMessage(input: SendMessageInput): Promise<SentMessage> {
    if (!input.content && !input.mediaUrl) throw new Error("sendMessage needs content or mediaUrl");
    const body: Dict = { number: input.number, from_number: input.fromNumber };
    if (input.content) body.content = input.content;
    if (input.mediaUrl) body.media_url = input.mediaUrl;
    if (input.sendStyle) body.send_style = input.sendStyle;
    if (input.replyToMessageHandle) body.reply_to = { message_handle: input.replyToMessageHandle };
    if (input.statusCallback) body.status_callback = input.statusCallback;
    return toSent(await this.request("POST", "/api/send-message", body));
  }

  async sendGroupMessage(input: SendGroupMessageInput): Promise<SentMessage> {
    if (!input.groupId && !(input.numbers && input.numbers.length > 0)) throw new Error("sendGroupMessage needs groupId or numbers");
    const body: Dict = { from_number: input.fromNumber };
    if (input.groupId) body.group_id = input.groupId;
    if (input.numbers) body.numbers = input.numbers;
    if (input.content) body.content = input.content;
    if (input.mediaUrl) body.media_url = input.mediaUrl;
    if (input.replyToMessageHandle) body.reply_to = { message_handle: input.replyToMessageHandle };
    return toSent(await this.request("POST", "/api/send-group-message", body));
  }

  /** The "..." bubble. iMessage 1:1 only, best effort. */
  async sendTyping(number: string, fromNumber: string): Promise<void> {
    await this.request("POST", "/api/send-typing-indicator", { number, from_number: fromNumber });
  }

  /** Tapback on an inbound message. Prefix the reaction with "-" to remove it. */
  async sendReaction(messageHandle: string, reaction: string, fromNumber: string): Promise<void> {
    await this.request("POST", "/api/send-reaction", { message_handle: messageHandle, reaction, from_number: fromNumber });
  }

  async markRead(number: string, fromNumber: string): Promise<void> {
    await this.request("POST", "/api/mark-read", { number, from_number: fromNumber });
  }

  /** Upload bytes and get back a media_url to send. Max 100 MB. */
  async uploadFile(content: Uint8Array, filename: string, contentType: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([content], { type: contentType }), filename);
    const res = await this.fetch(`${this.base}/api/upload-file`, { method: "POST", headers: this.headers(false), body: form });
    const d = await this.handle<Dict>(res);
    const url = str(d.media_url) ?? str(d.mediaUrl) ?? str(d.url);
    if (!url) throw new SendblueHttpError(res.status, "Sendblue upload returned no media_url", undefined, d);
    return url;
  }

  /** "iMessage" or "SMS" for a number. Unknown results throw; never cache a failed lookup as SMS. */
  async evaluateService(number: string): Promise<string> {
    const d = await this.request<Dict>("GET", `/api/evaluate-service?number=${encodeURIComponent(number)}`);
    const service = str(d.service);
    if (!service) throw new SendblueHttpError(200, "evaluate-service returned no service", undefined, d);
    return service;
  }

  /** The lines on this account, E.164. */
  async listLines(): Promise<string[]> {
    const d = await this.request<unknown>("GET", "/api/lines");
    const rows = Array.isArray(d) ? d : Array.isArray((d as Dict)?.lines) ? ((d as Dict).lines as unknown[]) : Array.isArray((d as Dict)?.data) ? ((d as Dict).data as unknown[]) : [];
    const out: string[] = [];
    for (const r of rows) {
      if (typeof r === "string") out.push(r);
      else if (r && typeof r === "object") {
        const n = str((r as Dict).phone_number) ?? str((r as Dict).number) ?? str((r as Dict).phoneNumber);
        if (n) out.push(n);
      }
    }
    return out;
  }
}

function toSent(d: Dict): SentMessage {
  const out: SentMessage = {};
  const handle = str(d.message_handle) ?? str(d.messageHandle);
  if (handle) out.messageHandle = handle;
  const status = str(d.status);
  if (status) out.status = status;
  const from = str(d.from_number) ?? str(d.sendblue_number);
  if (from) out.fromNumber = from;
  const service = str(d.service);
  if (service) out.service = service;
  const group = str(d.group_id);
  if (group) out.groupId = group;
  return out;
}
