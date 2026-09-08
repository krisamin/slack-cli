import { slackApi } from "../api";
import { loadConfig, resolveProfile } from "../config";
import { extractMentions, header, renderMessage, type SlackMessage } from "../render";
import { parseSlackUrl } from "../url";
import { UserResolver } from "../users";

interface RepliesResponse {
  ok: boolean;
  messages: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface ChannelInfoResponse {
  ok: boolean;
  channel: { name?: string };
}

/** Collect every message in a thread via cursor pagination (up to maxPages * 200). */
export const fetchThread = async (
  profile: { token: string; cookie: string },
  channelId: string,
  threadTs: string,
  maxPages = 10,
): Promise<SlackMessage[]> => {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string> = {
      channel: channelId,
      ts: threadTs,
      limit: "200",
    };
    if (cursor) params.cursor = cursor;
    const res = await slackApi<RepliesResponse>(profile, "conversations.replies", params);
    messages.push(...res.messages);
    cursor = res.response_metadata?.next_cursor;
    if (!res.has_more || !cursor) break;
  }
  return messages;
};

/**
 * Render a thread. Returns the text instead of printing it: the CLI writes it to
 * stdout, the MCP server hands it back as tool content. Nothing here may print,
 * because under the MCP stdio transport stdout carries JSON-RPC frames only.
 */
export const read = async (url: string, opts: { profile?: string; json: boolean }): Promise<string> => {
  const config = await loadConfig();
  const { name, profile } = resolveProfile(config, opts.profile);
  const parsed = parseSlackUrl(url);
  if (!parsed.threadTs) throw new Error("URL has no message ts — a bare channel link can't identify a thread.");

  const messages = await fetchThread(profile, parsed.channelId, parsed.threadTs);

  if (opts.json) return JSON.stringify(messages, null, 2);

  const resolver = new UserResolver(profile, name);
  await resolver.load();
  const users = await resolver.resolveMany(extractMentions(messages));
  await resolver.save();

  let channelLabel = parsed.channelId;
  try {
    const info = await slackApi<ChannelInfoResponse>(profile, "conversations.info", {
      channel: parsed.channelId,
    });
    if (info.channel.name) channelLabel = `#${info.channel.name}`;
  } catch {
    // private/unknown channel — keep the raw ID
  }

  const [root, ...replies] = messages;
  const out: string[] = [header(`${channelLabel} · ${replies.length} replies`), ""];
  if (root) {
    out.push(renderMessage(root, users), "");
  }
  for (const msg of replies) {
    out.push(renderMessage(msg, users), "");
  }
  return out.join("\n").trimEnd();
};
