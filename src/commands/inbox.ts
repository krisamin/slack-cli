import { backfill, sync } from "../inbox/run";
import { SETTING_PATH } from "../inbox/setting";
import { ack, channelTable, digest, mark, pending, stats, tickLine } from "../inbox/view";
import { parseTime } from "../time";

export const INBOX_HELP = `slack inbox — keep a local inbox of what needs you (SQLite, ~/.local/share/slack-cli)

  slack inbox sync                       collect since the last run (search + DMs + followed threads)
  slack inbox backfill --since <when> [--items-since <when>]
                                         first run: archive every conversation you are in from a date on;
                                         raise items only from --items-since (default: same)
  slack inbox pending [--tier 1] [--brief] [--json] [--no-refresh]
                                         unacknowledged items with their threads
  slack inbox ack --upto <n> [--tier 1] | <key...>
                                         acknowledge items (local only, Slack stays unread)
  slack inbox digest --since <when> [--json]
                                         every thread people wrote in since then, acked or not (for summaries)
  slack inbox mark                       one line that changes when something of yours arrives
                                         (tier 1 only; watched channels wait for the briefing)
  slack inbox tick                       sync, then mark (for a 10-minute poller)
  slack inbox stats                      cursor, counts, last run
  slack inbox channels                   channel grades and suggestions

Settings: ${SETTING_PATH}
  nameList, watchList, watchPrefixList, botList, muteList, overlapSecond
`;

export interface InboxArg {
  sub?: string;
  restList: string[];
  profile?: string;
  since?: string;
  itemSince?: string;
  upto?: string;
  tier?: string;
  json: boolean;
  brief: boolean;
  noRefresh: boolean;
}

export const inbox = async (arg: InboxArg): Promise<string> => {
  switch (arg.sub) {
    case "sync":
      return sync(arg.profile);
    case "backfill": {
      if (!arg.since) throw new Error("Usage: slack inbox backfill --since <when> [--items-since <when>]");
      const archiveMs = parseTime(arg.since, "start");
      return backfill(archiveMs, arg.itemSince ? parseTime(arg.itemSince, "start") : archiveMs, arg.profile);
    }
    case "pending":
      return pending({
        profile: arg.profile,
        json: arg.json,
        refresh: !arg.noRefresh,
        tier: arg.tier ? Number(arg.tier) : 2,
        brief: arg.brief,
      });
    case "ack": {
      const upto = arg.upto !== undefined ? Number(arg.upto) : undefined;
      if (upto === undefined && !arg.restList.length) throw new Error("Usage: slack inbox ack --upto <n> | <key...>");
      return ack({
        profile: arg.profile,
        ...(upto !== undefined ? { upto } : {}),
        ...(arg.tier ? { tier: Number(arg.tier) } : {}),
        keyList: arg.restList,
      });
    }
    case "digest": {
      if (!arg.since) throw new Error("Usage: slack inbox digest --since <when> [--json]");
      return digest({ profile: arg.profile, sinceMs: parseTime(arg.since, "start"), json: arg.json });
    }
    case "mark":
      return mark(arg.profile);
    case "tick": {
      // A failed sync still prints the mark: auth FAIL is exactly what the poller
      // must see. Other errors only show after three runs in a row, so one network
      // blip does not wake anyone, and the line stays the same while it lasts.
      let failure = "";
      try {
        await sync(arg.profile);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      return tickLine(arg.profile, failure);
    }
    case "stats":
      return stats(arg.profile);
    case "channels":
      return channelTable(arg.profile);
    default:
      return INBOX_HELP;
  }
};
