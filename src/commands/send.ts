import { slackApi } from "../api";
import type { Profile } from "../config";
import { loadConfig, resolveProfile } from "../config";
import { parseSlackUrl } from "../url";

/**
 * Slack's own reference syntax: <@U123>, <#C123|name>, <!here>, <https://x|label>.
 * Everything else stays literal text, so *stars* and _underscores_ go out as typed.
 */
const REFERENCE_PATTERN = /<(@[UW][A-Z0-9]+|#C[A-Z0-9]+|![a-z]+|https?:\/\/[^>|\s]+)(?:\|([^>]*))?>/g;

const BROADCAST_RANGE_SET = new Set(["here", "channel", "everyone"]);

const referenceElement = (ref: string, label: string | undefined): Record<string, unknown> | undefined => {
  if (ref.startsWith("@")) return { type: "user", user_id: ref.slice(1) };
  if (ref.startsWith("#")) return { type: "channel", channel_id: ref.slice(1) };
  if (ref.startsWith("!")) {
    const range = ref.slice(1);
    return BROADCAST_RANGE_SET.has(range) ? { type: "broadcast", range } : undefined;
  }
  return label ? { type: "link", url: ref, text: label } : { type: "link", url: ref };
};

/**
 * One rich_text section, the shape the Slack composer sends. Text is kept
 * verbatim except Slack reference tokens, which become real mention, channel
 * and link elements; inside rich_text a literal <@U123> would show as is.
 */
export const plainTextBlockList = (text: string): unknown[] => {
  const elementList: Record<string, unknown>[] = [];
  let cursor = 0;
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const element = referenceElement(match[1] ?? "", match[2] || undefined);
    if (!element) continue;
    const start = match.index ?? 0;
    if (start > cursor) elementList.push({ type: "text", text: text.slice(cursor, start) });
    elementList.push(element);
    cursor = start + match[0].length;
  }
  if (cursor < text.length) elementList.push({ type: "text", text: text.slice(cursor) });
  return [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: elementList }] }];
};

interface PostMessageResponse {
  ok: boolean;
  channel: string;
  ts: string;
}

interface PermalinkResponse {
  ok: boolean;
  permalink: string;
}

export interface PostTarget {
  channelId: string;
  threadTs?: string;
  broadcast: boolean;
}

/**
 * Post as the signed-in user and return a report with the new message's link.
 * The body goes out as one rich_text section, the same shape drafts use, so a
 * message reads exactly as the text you passed: no mrkdwn is interpreted, only
 * Slack reference tokens such as <@U123> turn into mentions.
 */
export const postMessage = async (
  profile: Profile,
  target: PostTarget,
  text: string,
  blockList: unknown[] = plainTextBlockList(text),
): Promise<string> => {
  const param: Record<string, string> = {
    channel: target.channelId,
    client_msg_id: crypto.randomUUID(),
    text,
    blocks: JSON.stringify(blockList),
  };
  if (target.threadTs) {
    param.thread_ts = target.threadTs;
    // reply_broadcast only means something on a thread reply
    if (target.broadcast) param.reply_broadcast = "true";
  }
  const res = await slackApi<PostMessageResponse>(profile, "chat.postMessage", param);

  // The message is already out; a failed permalink lookup must not read as a failed send.
  const permalink = await slackApi<PermalinkResponse>(profile, "chat.getPermalink", {
    channel: res.channel,
    message_ts: res.ts,
  })
    .then((link) => link.permalink)
    .catch(() => undefined);

  const where = target.threadTs
    ? `${res.channel} thread ${target.threadTs}${target.broadcast ? " (also sent to channel)" : ""}`
    : `${res.channel} (channel message)`;
  return [
    `✓ message sent (ts: ${res.ts})`,
    `  target: ${where}`,
    ...(permalink ? [`  link  : ${permalink}`] : []),
  ].join("\n");
};

/**
 * Send right away, as you. Unlike `draft write` there is no review step, so the
 * body arrives already resolved: reading -f or stdin is the CLI's job, and under
 * the MCP stdio transport stdin carries JSON-RPC frames.
 */
export const send = async (
  url: string,
  opts: { profile?: string; text: string; broadcast: boolean },
): Promise<string> => {
  const config = await loadConfig();
  const { profile } = resolveProfile(config, opts.profile);
  const parsed = parseSlackUrl(url);

  const text = opts.text.trimEnd();
  if (!text) throw new Error("Message body is empty.");
  if (opts.broadcast && !parsed.threadTs) {
    throw new Error("--broadcast only applies to a thread reply; this URL points at a channel.");
  }

  return postMessage(
    profile,
    { channelId: parsed.channelId, threadTs: parsed.threadTs, broadcast: opts.broadcast },
    text,
  );
};
