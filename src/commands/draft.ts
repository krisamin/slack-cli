import { slackApi } from "../api";
import { loadConfig, resolveProfile } from "../config";
import { formatTs, header } from "../render";
import { parseSlackUrl } from "../url";

interface Draft {
  id: string;
  last_updated_ts: string;
  is_deleted?: boolean;
  is_sent?: boolean;
  destinations?: { channel_id?: string; thread_ts?: string }[];
  blocks?: unknown[];
  text?: string;
}

interface DraftsListResponse {
  ok: boolean;
  drafts?: Draft[];
}

interface DraftsCreateResponse {
  ok: boolean;
  draft: { id: string };
}

const draftText = (draft: Draft): string => {
  if (draft.text) return draft.text;
  // drafts.list may return blocks only — extract plain text from rich_text blocks
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
      if (Array.isArray(obj.elements)) walk(obj.elements);
    }
  };
  walk(draft.blocks ?? []);
  return parts.join("");
};

export const draftWrite = async (
  url: string,
  opts: { profile?: string; message?: string; file?: string; broadcast: boolean },
): Promise<void> => {
  const config = await loadConfig();
  const { profile } = resolveProfile(config, opts.profile);
  const parsed = parseSlackUrl(url);

  let text: string;
  if (opts.message !== undefined) {
    text = opts.message;
  } else if (opts.file !== undefined) {
    text = (await Bun.file(opts.file).text()).trimEnd();
  } else if (!process.stdin.isTTY) {
    text = (await Bun.stdin.text()).trimEnd();
  } else {
    throw new Error("No message body. Pass -m <text>, -f <file>, or pipe via stdin.");
  }
  if (!text) throw new Error("Message body is empty.");

  const destination: Record<string, unknown> = { channel_id: parsed.channelId, broadcast: opts.broadcast };
  const isReply = Boolean(parsed.threadTs);
  if (isReply) destination.thread_ts = parsed.threadTs;

  const blocks = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [{ type: "text", text }],
        },
      ],
    },
  ];

  const res = await slackApi<DraftsCreateResponse>(profile, "drafts.create", {
    client_msg_id: crypto.randomUUID(),
    type: isReply ? "reply" : "message",
    destinations: JSON.stringify([destination]),
    text,
    blocks: JSON.stringify(blocks),
    file_ids: "[]",
    is_from_composer: "false",
  });

  console.log(`✓ draft created (id: ${res.draft.id})`);
  console.log(`  target: ${parsed.channelId}${isReply ? ` thread ${parsed.threadTs}` : " (channel message)"}`);
  console.log("  Review and send it from Slack.");
};

export const draftList = async (opts: { profile?: string; json: boolean }): Promise<void> => {
  const config = await loadConfig();
  const { profile } = resolveProfile(config, opts.profile);
  const res = await slackApi<DraftsListResponse>(profile, "drafts.list");
  const drafts = (res.drafts ?? []).filter((d) => !d.is_deleted && !d.is_sent);

  if (opts.json) {
    console.log(JSON.stringify(drafts, null, 2));
    return;
  }

  if (drafts.length === 0) {
    console.log("No drafts.");
    return;
  }

  console.log(header(`${drafts.length} draft${drafts.length > 1 ? "s" : ""}`));
  for (const draft of drafts) {
    const dest = draft.destinations?.[0];
    const target = dest?.thread_ts
      ? `${dest.channel_id} thread ${dest.thread_ts}`
      : (dest?.channel_id ?? "(no destination)");
    const preview = draftText(draft).replace(/\n/g, " ").slice(0, 60);
    console.log(`\n${draft.id}`);
    console.log(`  target : ${target}`);
    console.log(`  updated: ${formatTs(draft.last_updated_ts)}`);
    console.log(`  text   : ${preview}${preview.length >= 60 ? "…" : ""}`);
  }
};

export const draftRemove = async (draftId: string, opts: { profile?: string }): Promise<void> => {
  const config = await loadConfig();
  const { profile } = resolveProfile(config, opts.profile);
  // Future timestamp bypasses draft_has_conflict when the Slack app has touched the draft
  const futureTs = (Date.now() / 1000 + 100).toFixed(6);
  await slackApi(profile, "drafts.delete", {
    draft_id: draftId,
    client_last_updated_ts: futureTs,
  });
  console.log(`✓ draft deleted (${draftId})`);
};
