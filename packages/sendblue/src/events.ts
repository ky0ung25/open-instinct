/**
 * Turn a Sendblue `receive` webhook into the runtime's InboundMessage. Outbound
 * echoes, status callbacks and anything without a sender return undefined.
 * Fields are read defensively; Sendblue's payload grows over time.
 */
import { normalizePhone, type InboundMessage } from "@open-instinct/core";
import { directKey, groupKey } from "./keys.js";

type Dict = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function dict(v: unknown): Dict | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
}

function phone(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (s.includes("@")) return s.toLowerCase(); // iCloud email senders
  return normalizePhone(s) || undefined;
}

/** Inbound statuses Sendblue uses for messages someone sent us. */
const INBOUND_STATUSES = new Set(["RECEIVED", "DELIVERED", ""]);

export function parseSendblueEvent(payload: unknown): InboundMessage | undefined {
  const d = dict(payload);
  if (!d) return undefined;
  if (d.is_outbound === true) return undefined;
  const status = (str(d.status) ?? "").toUpperCase();
  if (!INBOUND_STATUSES.has(status)) return undefined;

  const from = phone(d.from_number) ?? phone(d.number);
  // The line they texted. `sendblue_number` is set on inbound; `to_number` is the fallback.
  const line = phone(d.sendblue_number) ?? phone(d.to_number);
  if (!from || !line) return undefined;

  const service = str(d.service) ?? "iMessage";
  const channel: "imessage" | "sms" = service.toLowerCase() === "imessage" ? "imessage" : "sms";
  const groupId = str(d.group_id);
  const conversationKey = groupId ? groupKey(groupId, line) : directKey(channel, line, from);

  const mediaUrl = str(d.media_url);
  const content = str(d.content) ?? "";
  const handle = str(d.message_handle);
  const replyTo = str(dict(d.reply_to)?.message_handle);

  const msg: InboundMessage = {
    id: handle ? `sendblue:${handle}` : `sendblue:${line}:${from}:${str(d.date_sent) ?? Date.now()}`,
    channel: groupId ? "imessage" : channel,
    conversationKey,
    from,
    text: content || (mediaUrl ? "[attachment]" : ""),
    replyRef: {
      provider: "sendblue",
      line,
      remote: from,
      messageId: handle,
      groupId,
      replyToMessageId: replyTo,
    },
    receivedAt: str(d.date_sent) ?? new Date().toISOString(),
    source: "webhook",
    meta: {
      isGroup: Boolean(groupId),
      conversationScopeKnown: true,
      participants: Array.isArray(d.participants) ? d.participants.filter((p): p is string => typeof p === "string") : [],
      service,
      optedOut: d.opted_out === true,
      groupName: str(d.group_display_name),
    },
  };
  if (mediaUrl) msg.attachments = [{ url: mediaUrl }];
  return msg;
}

/** Words Sendblue and carriers treat as an opt-out. Sendblue also flags `opted_out`. */
export const OPT_OUT_WORDS = new Set(["stop", "unsubscribe", "cancel", "opt out", "optout", "revoke", "end", "quit"]);

export function isOptOut(msg: InboundMessage): boolean {
  if (msg.meta?.optedOut === true) return true;
  return OPT_OUT_WORDS.has(msg.text.trim().toLowerCase());
}
