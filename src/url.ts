export interface SlackUrl {
  workspace: string;
  channelId: string;
  /** ts of the linked message, e.g. "1782090279.095849" */
  messageTs?: string;
  /** root ts of the thread (from ?thread_ts=), falls back to messageTs */
  threadTs?: string;
}

/**
 * Parse a Slack archive URL.
 * https://{ws}.slack.com/archives/{CHANNEL}/p{sec}{micro}?thread_ts={ts}&cid={CHANNEL}
 */
export const parseSlackUrl = (raw: string): SlackUrl => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  const wsMatch = url.hostname.match(/^([^.]+)\.slack\.com$/);
  if (!wsMatch?.[1]) throw new Error(`Not a Slack URL: ${url.hostname}`);

  // web client links (app.slack.com/client/T.../C...) carry the channel but no message
  const clientMatch = url.pathname.match(/^\/client\/[A-Z0-9]+\/([A-Z0-9]+)/);
  if (clientMatch?.[1]) return { workspace: wsMatch[1], channelId: clientMatch[1] };

  const pathMatch = url.pathname.match(/\/archives\/([A-Z0-9]+)(?:\/p(\d{10})(\d{6}))?/);
  if (!pathMatch?.[1]) throw new Error(`Can't parse a channel from: ${url.pathname}`);

  const messageTs = pathMatch[2] && pathMatch[3] ? `${pathMatch[2]}.${pathMatch[3]}` : undefined;
  const threadTs = url.searchParams.get("thread_ts") ?? messageTs;

  return {
    workspace: wsMatch[1],
    channelId: pathMatch[1],
    messageTs,
    threadTs: threadTs ?? undefined,
  };
};
