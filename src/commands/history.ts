import { slackApi } from "../api";
import { loadConfig, type Profile, resolveProfile } from "../config";
import { extractMentions, formatTs, header, renderMessage, type SlackMessage } from "../render";
import { parseTime, toSlackTs } from "../time";
import { parseSlackUrl } from "../url";
import { UserResolver } from "../users";
import { fetchThread } from "./read";

interface HistoryResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface ChannelInfoResponse {
  ok: boolean;
  channel: { name?: string };
}

interface AuthTestResponse {
  ok: boolean;
  url: string;
}

export interface HistoryOptions {
  profile?: string;
  since: string;
  until?: string;
  /** Also fetch and print every reply under each thread. */
  thread: boolean;
  json: boolean;
}

/** 200 per page, so this stops at 10,000 channel messages. Narrow the range past that. */
const MAX_PAGES = 50;

/** Channel messages in [oldest, latest], oldest first. */
const fetchHistory = async (
  profile: Profile,
  channelId: string,
  oldest: string,
  latest: string,
): Promise<{ messages: SlackMessage[]; truncated: boolean }> => {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      channel: channelId,
      oldest,
      latest,
      inclusive: "true",
      limit: "200",
    };
    if (cursor) params.cursor = cursor;
    const res = await slackApi<HistoryResponse>(profile, "conversations.history", params);
    messages.push(...res.messages);
    cursor = res.response_metadata?.next_cursor;
    if (!res.has_more || !cursor) return { messages: messages.reverse(), truncated: false };
  }
  return { messages: messages.reverse(), truncated: true };
};

/**
 * Base URL for permalinks. The link's own host is right unless it came from the
 * web client (app.slack.com/client/...), which does not name the workspace.
 */
const workspaceBase = async (profile: Profile, workspace: string): Promise<string> => {
  if (workspace !== "app") return `https://${workspace}.slack.com`;
  const auth = await slackApi<AuthTestResponse>(profile, "auth.test");
  return auth.url.replace(/\/$/, "");
};

const permalink = (base: string, channelId: string, ts: string, threadTs?: string): string => {
  const link = `${base}/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${link}?thread_ts=${threadTs}&cid=${channelId}` : link;
};

const indent = (text: string, pad: string): string => {
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
};

/**
 * Every channel message between two times, each thread marked with its reply
 * count and a link that `slack read` (or thread_read) takes as is. With
 * `thread`, the replies are fetched and printed under their root as well.
 */
export const history = async (url: string, opts: HistoryOptions): Promise<string> => {
  const config = await loadConfig();
  const { name, profile } = resolveProfile(config, opts.profile);
  const parsed = parseSlackUrl(url);

  const now = Date.now();
  const sinceMs = parseTime(opts.since, "start", now);
  const untilMs = opts.until ? parseTime(opts.until, "end", now) : now;
  if (sinceMs > untilMs) throw new Error(`--since (${opts.since}) is after --until (${opts.until ?? "now"}).`);

  const { messages, truncated } = await fetchHistory(profile, parsed.channelId, toSlackTs(sinceMs), toSlackTs(untilMs));
  const base = await workspaceBase(profile, parsed.workspace);

  // thread roots only: a thread_broadcast also shows up here, but its replies belong to the root
  const isRoot = (msg: SlackMessage): boolean =>
    (msg.reply_count ?? 0) > 0 && (!msg.thread_ts || msg.thread_ts === msg.ts);
  const replyMap = new Map<string, SlackMessage[]>();
  if (opts.thread) {
    for (const msg of messages) {
      if (!isRoot(msg)) continue;
      const [, ...replies] = await fetchThread(profile, parsed.channelId, msg.ts);
      replyMap.set(msg.ts, replies);
    }
  }

  if (opts.json) {
    return JSON.stringify(
      messages.map((msg) => ({
        ...msg,
        permalink: permalink(base, parsed.channelId, msg.ts, msg.thread_ts),
        ...(isRoot(msg) ? { thread_url: permalink(base, parsed.channelId, msg.ts) } : {}),
        ...(replyMap.has(msg.ts) ? { replies: replyMap.get(msg.ts) } : {}),
      })),
      null,
      2,
    );
  }

  const resolver = new UserResolver(profile, name);
  await resolver.load();
  const users = await resolver.resolveMany(extractMentions([...messages, ...[...replyMap.values()].flat()]));
  await resolver.save();

  let channelLabel = parsed.channelId;
  try {
    const info = await slackApi<ChannelInfoResponse>(profile, "conversations.info", { channel: parsed.channelId });
    if (info.channel.name) channelLabel = `#${info.channel.name}`;
  } catch {
    // private/unknown channel — keep the raw ID
  }

  const threadCount = messages.filter(isRoot).length;
  const range = `${formatTs(toSlackTs(sinceMs))} → ${opts.until ? formatTs(toSlackTs(untilMs)) : "now"}`;
  const out: string[] = [
    header(`${channelLabel} · ${range} · ${messages.length} messages, ${threadCount} threads`),
    "",
  ];
  if (truncated) {
    out.push(`(stopped at ${MAX_PAGES * 200} messages — narrow the range to see the rest)`, "");
  }

  for (const msg of messages) {
    out.push(renderMessage(msg, users));
    if (isRoot(msg)) {
      const last = msg.latest_reply ? `, last ${formatTs(msg.latest_reply)}` : "";
      out.push(`  └ thread: ${msg.reply_count} replies${last} · ${permalink(base, parsed.channelId, msg.ts)}`);
      for (const reply of replyMap.get(msg.ts) ?? []) {
        out.push("", indent(renderMessage(reply, users), "      "));
      }
    } else if (msg.thread_ts && msg.thread_ts !== msg.ts) {
      out.push(`  └ reply also sent to channel · thread ${permalink(base, parsed.channelId, msg.thread_ts)}`);
    } else {
      out.push(`  └ url: ${permalink(base, parsed.channelId, msg.ts)}`);
    }
    out.push("");
  }
  if (messages.length === 0) out.push("(no messages in this range)");
  return out.join("\n").trimEnd();
};
