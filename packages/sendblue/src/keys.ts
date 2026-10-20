/**
 * Conversation keys for Sendblue threads. Sendblue has no conversation id: a 1:1
 * thread is the pair (our line, their number), and a group is its group_id. The
 * line is part of the key so a reply always leaves on the line the person texted.
 *
 *   imessage:+15125550100/+14155550199   one-to-one on iMessage
 *   sms:+15125550100/+14155550199        one-to-one that fell back to SMS
 *   imessage:group/<group_id>@+15125550100
 */

export interface SendblueKey {
  channel: "imessage" | "sms";
  /** Our Sendblue line, E.164. */
  line: string;
  /** Their number for a 1:1 thread. */
  remote?: string;
  /** Sendblue group id for a group thread. */
  groupId?: string;
}

export function directKey(channel: "imessage" | "sms", line: string, remote: string): string {
  return `${channel}:${line}/${remote}`;
}

export function groupKey(groupId: string, line: string): string {
  return `imessage:group/${groupId}@${line}`;
}

export function parseSendblueKey(key: string | undefined): SendblueKey | undefined {
  if (!key) return undefined;
  const idx = key.indexOf(":");
  if (idx < 0) return undefined;
  const channel = key.slice(0, idx);
  if (channel !== "imessage" && channel !== "sms") return undefined;
  const rest = key.slice(idx + 1);
  if (rest.startsWith("group/")) {
    const body = rest.slice("group/".length);
    const at = body.lastIndexOf("@");
    if (at <= 0) return undefined;
    return { channel: "imessage", groupId: body.slice(0, at), line: body.slice(at + 1) };
  }
  const slash = rest.indexOf("/");
  if (slash <= 0) return undefined;
  const line = rest.slice(0, slash);
  const remote = rest.slice(slash + 1);
  if (!line.startsWith("+") || !remote) return undefined;
  return { channel, line, remote };
}
