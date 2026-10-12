import { analyzeThread, askLocal } from "../local/analysis";
import { parseMode } from "../local/model";
import { readLocal } from "../local/read";
import { parseSearch, parseThread } from "../local/store";
import { boolean, keys, record, text } from "../local/validation";
import { parseSlackUrl } from "../url";

export const ANALYZE_HELP = `Read-only local cache analysis (JSON output):
  slack analyze thread <channel-id> <root-ts> [--mode foreground|batch] [--think]
  slack analyze <thread-url> [--mode foreground|batch] [--think]
  slack analyze ask <question> [--mode foreground|batch] [--think]
  slack analyze search [query] [--channel <id>] [--user <id>]
      [--since <YYYY-MM-DD|ISO>] [--until <YYYY-MM-DD|ISO>] [--limit <1..50>]
  slack analyze metadata

Model config: ~/.config/slack-cli/model.json (0600; loopback HTTP /v1 only).
Cache: ~/.local/share/slack-cli/inbox.db (readonly; never refreshed here).
Batch skips busy or unknown health/slots, uses concurrency 1 and one bounded work unit.
Date-only filters are UTC; until is exclusive. Omission/uncertainty requires human review.
`;

export const localSearch = async (value: unknown): Promise<string> => {
  const input = parseSearch(value);
  return JSON.stringify(await readLocal("search", input), null, 2);
};

export const localThread = async (value: unknown): Promise<string> => {
  return JSON.stringify(await readLocal("thread", parseThread(value)), null, 2);
};

export const localMetadata = async (value: unknown): Promise<string> => {
  keys(record(value), []);
  return JSON.stringify(await readLocal("metadata"), null, 2);
};

export const localAnalyze = async (value: unknown): Promise<string> => {
  const input = record(value);
  keys(input, ["channel_id", "root_ts", "mode", "think"]);
  const target = parseThread({ channel_id: input.channel_id, root_ts: input.root_ts });
  return JSON.stringify(
    await analyzeThread({ ...target, mode: parseMode(input.mode), think: boolean(input.think, "think") }),
    null,
    2,
  );
};

export const localAsk = async (value: unknown): Promise<string> => {
  const input = record(value);
  keys(input, ["question", "mode", "think"]);
  return JSON.stringify(
    await askLocal({
      question: text(input.question, "question", 2000) ?? "",
      mode: parseMode(input.mode),
      think: boolean(input.think, "think"),
    }),
    null,
    2,
  );
};

export const analyze = async (rest: string[], flags: Record<string, string | boolean>): Promise<string> => {
  keys(flags, ["channel", "user", "since", "until", "limit", "mode", "think", "json"]);
  const [sub, ...argumentList] = rest;
  if (!sub) return ANALYZE_HELP;
  const mode = flags.mode;
  const think = flags.think;
  if (sub === "metadata") {
    if (argumentList.length) throw new Error("metadata does not accept positional arguments.");
    return localMetadata({});
  }
  if (sub === "search") {
    return localSearch({
      query: argumentList.length ? argumentList.join(" ") : undefined,
      channel_id: flags.channel,
      user_id: flags.user,
      since: flags.since,
      until: flags.until,
      limit: flags.limit === undefined ? undefined : Number(flags.limit),
    });
  }
  if (sub === "ask") return localAsk({ question: argumentList.join(" "), mode, think });
  if (sub === "thread") {
    if (argumentList.length !== 2) throw new Error("Usage: slack analyze thread <channel-id> <root-ts>");
    return localAnalyze({ channel_id: argumentList[0], root_ts: argumentList[1], mode, think });
  }
  if (argumentList.length) throw new Error("Expected a single thread URL.");
  const parsed = parseSlackUrl(sub);
  if (!parsed.threadTs) throw new Error("Expected a Slack thread URL, not a channel URL.");
  const base = (await readLocal("metadata")).base_url;
  if (!base || new URL(base).hostname !== `${parsed.workspace}.slack.com`) {
    throw new Error("Thread URL does not match the local cache workspace.");
  }
  return localAnalyze({ channel_id: parsed.channelId, root_ts: parsed.threadTs, mode, think });
};
