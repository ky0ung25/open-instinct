/**
 * Outbound side of the Sendblue adapter, a drop-in for InkboxChannel's Outbox role.
 * Replies always leave on the line in the conversation key, so an owner never sees
 * their assistant answer from a different number.
 */
import type { OutboundMessage, Outbox, Principal } from "@open-instinct/core";
import { SendblueClient, type SendblueClientOptions } from "./client.js";
import { directKey, parseSendblueKey } from "./keys.js";

/** Long texts read badly as one bubble; split past this. */
export const IMESSAGE_MAX_CHARS = 1500;
/** Sendblue's media cap. */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
/** SMS fallback media cap. */
export const SMS_MEDIA_MAX_BYTES = 5 * 1024 * 1024;

export interface SendblueChannelOptions extends SendblueClientOptions {
  /** Line to start new threads from when the message has no conversation key. */
  defaultLine?: string;
  /** Called for every message this channel sends, e.g. LinePool.record. */
  onSent?: (line: string, count: number) => void;
  statusCallback?: string;
}

export interface FileSend {
  conversationKey: string;
  filename: string;
  contentType: string;
  content: Buffer;
  caption?: string;
}

/** Same splitting rule as the Inkbox adapter: paragraph, then sentence, then space. */
export function splitMessageText(text: string, max = IMESSAGE_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.4) cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut < max * 0.4) cut = max;
    else cut += 1;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function toList(to: string | string[] | undefined): string[] {
  if (!to) return [];
  return (Array.isArray(to) ? to : [to]).map((s) => s.trim()).filter(Boolean);
}

export class SendblueChannel implements Outbox {
  readonly client: SendblueClient;
  private readonly opts: SendblueChannelOptions;

  constructor(opts: SendblueChannelOptions) {
    this.opts = opts;
    this.client = new SendblueClient(opts);
  }

  private counted(line: string, n = 1): void {
    this.opts.onSent?.(line, n);
  }

  async send(msg: OutboundMessage, _ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    if (msg.channel !== "imessage" && msg.channel !== "sms") {
      throw new Error(`SendblueChannel cannot deliver on channel "${msg.channel}" (key ${msg.conversationKey ?? "none"})`);
    }
    const key = parseSendblueKey(msg.conversationKey);
    const line = key?.line ?? msg.replyRef?.line ?? this.opts.defaultLine;
    if (!line) throw new Error("Sendblue send needs a conversation key with a line, replyRef.line, or a defaultLine");

    const chunks = splitMessageText(msg.text);
    const media = msg.mediaUrls ?? [];
    if (chunks.length === 0 && media.length === 0) return;

    if (key?.groupId) {
      for (let i = 0; i < Math.max(chunks.length, media.length, 1); i++) {
        const input: Parameters<SendblueClient["sendGroupMessage"]>[0] = { groupId: key.groupId, fromNumber: line };
        if (chunks[i]) input.content = chunks[i];
        if (media[i]) input.mediaUrl = media[i];
        if (i === 0 && msg.replyToMessageId) input.replyToMessageHandle = msg.replyToMessageId;
        if (!input.content && !input.mediaUrl) continue;
        await this.client.sendGroupMessage(input);
        this.counted(line);
      }
      return;
    }

    const recipients = key?.remote ? [key.remote] : toList(msg.to);
    if (recipients.length === 0) throw new Error("Sendblue send needs a conversation key or a `to` number");
    for (const number of recipients) {
      // Sendblue takes one media_url per message: media first, text after, one bubble each.
      for (let i = 0; i < media.length; i++) {
        const input: Parameters<SendblueClient["sendMessage"]>[0] = { number, fromNumber: line, mediaUrl: media[i]! };
        if (i === 0 && msg.replyToMessageId) input.replyToMessageHandle = msg.replyToMessageId;
        if (this.opts.statusCallback) input.statusCallback = this.opts.statusCallback;
        await this.client.sendMessage(input);
        this.counted(line);
      }
      for (let i = 0; i < chunks.length; i++) {
        const input: Parameters<SendblueClient["sendMessage"]>[0] = { number, fromNumber: line, content: chunks[i]! };
        if (i === 0 && media.length === 0 && msg.replyToMessageId) input.replyToMessageHandle = msg.replyToMessageId;
        if (i === 0 && msg.sendStyle) input.sendStyle = msg.sendStyle;
        if (this.opts.statusCallback) input.statusCallback = this.opts.statusCallback;
        await this.client.sendMessage(input);
        this.counted(line);
      }
    }
  }

  /** Upload a file and send it in the thread, caption as its own bubble. */
  async sendFile(file: FileSend): Promise<{ mediaUrl: string }> {
    const key = parseSendblueKey(file.conversationKey);
    if (!key) throw new Error(`Not a Sendblue conversation key: ${file.conversationKey}`);
    const cap = key.channel === "sms" ? SMS_MEDIA_MAX_BYTES : MEDIA_MAX_BYTES;
    if (file.content.length > cap) throw new Error(`${file.filename} is too large for ${key.channel === "sms" ? "SMS" : "iMessage"}; send it by email instead`);
    const mediaUrl = await this.client.uploadFile(new Uint8Array(file.content), file.filename, file.contentType);
    await this.send({ channel: key.channel, conversationKey: file.conversationKey, text: file.caption ?? "", mediaUrls: [mediaUrl] }, { principal: undefined as never, conversationKey: file.conversationKey });
    return { mediaUrl };
  }

  /**
   * Send the assistant's contact card (a public .vcf URL). Do this on the first reply
   * on a line and after any move to a new line, so the thread shows the right name.
   */
  async sendContactCard(line: string, person: string, vcfUrl: string): Promise<void> {
    if (!vcfUrl.toLowerCase().endsWith(".vcf")) throw new Error("Contact card URL must end in .vcf");
    await this.client.sendMessage({ number: person, fromNumber: line, mediaUrl: vcfUrl });
    this.counted(line);
  }

  /** Start a fresh 1:1 thread key for a person on a line (used after assigning a home line). */
  keyFor(line: string, person: string): string {
    return directKey("imessage", line, person);
  }

  async typing(conversationKey: string): Promise<void> {
    const key = parseSendblueKey(conversationKey);
    if (!key || key.channel !== "imessage" || !key.remote) return;
    await this.client.sendTyping(key.remote, key.line).catch(() => undefined);
  }

  async react(conversationKey: string, messageId: string, reaction: string): Promise<void> {
    const key = parseSendblueKey(conversationKey);
    if (!key || key.channel !== "imessage") throw new Error("Tapbacks are only available on iMessage conversations");
    await this.client.sendReaction(messageId, reaction, key.line);
  }

  async markRead(conversationKey: string): Promise<void> {
    const key = parseSendblueKey(conversationKey);
    if (!key || key.channel !== "imessage" || !key.remote) return;
    await this.client.markRead(key.remote, key.line).catch(() => undefined);
  }
}
