import { constants, Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { channelId, dateSecond, integer, keys, record, text, timestamp } from "./validation";

export const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "slack-cli", "inbox.db");
const SCAN_MAX = 20_000;
const MESSAGE_MAX = 200;
const CONTEXT_MAX = 24_000;
const OMITTED_MAX = 1000;

export interface LocalMessage {
  channel_id: string;
  ts: string;
  thread_ts: string;
  user: string;
  text: string;
  bot: number;
  deleted: number;
  edited_ts: string;
  reply_count: number;
  latest_reply: string;
  seen_at: number;
}

export interface Freshness {
  fetched_at: string;
  last_sync: string | null;
  asof: string | null;
  db_fingerprint: string;
  schema_version: number;
  data_version: number;
  source: "local_cache";
}

export interface ThreadResult {
  freshness: Freshness;
  channel_id: string;
  root_ts: string;
  self_user: string | null;
  url: string | null;
  thread_fetched_at: number | null;
  root: LocalMessage;
  message_list: LocalMessage[];
  omitted_id_list: string[];
  omitted_count: number;
  omitted_id_list_truncated: boolean;
  truncated: boolean;
  needs_human: boolean;
  cached_message_count: number;
  expected_reply_count: number;
  cache_incomplete: boolean;
}

export interface SearchInput {
  query?: string;
  channel_id?: string;
  user_id?: string;
  since?: string;
  until?: string;
  limit?: number;
}

const COLUMN = "channel_id,ts,thread_ts,user,text,bot,deleted,edited_ts,reply_count,latest_reply,seen_at";

export const parseSearch = (value: unknown): SearchInput => {
  const input = record(value);
  keys(input, ["query", "channel_id", "user_id", "since", "until", "limit"]);
  const query = text(input.query, "query", 500, true);
  const channel = input.channel_id === undefined ? undefined : channelId(input.channel_id);
  const user = text(input.user_id, "user_id", 32, true);
  if (user !== undefined && !/^[UBW][A-Z0-9]+$/.test(user)) throw new Error("Invalid user_id.");
  const since = text(input.since, "since", 40, true);
  const until = text(input.until, "until", 40, true);
  const start = dateSecond(since, "since");
  const end = dateSecond(until, "until");
  if (start !== undefined && end !== undefined && start > end) throw new Error("since must not be after until.");
  if (!query && !channel && !user && !since && !until) throw new Error("At least one search filter is required.");
  return { query, channel_id: channel, user_id: user, since, until, limit: integer(input.limit, "limit", 20, 50) };
};

export const parseThread = (value: unknown): { channel_id: string; root_ts: string } => {
  const input = record(value);
  keys(input, ["channel_id", "root_ts"]);
  return { channel_id: channelId(input.channel_id), root_ts: timestamp(input.root_ts) };
};

export class LocalStore {
  readonly db: Database;
  readonly dbPath: string;

  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = resolve(dbPath);
    // Bun's object {readonly:true} does not enable SQLITE_OPEN_URI. Use the
    // equivalent explicit READONLY flag plus URI, never CREATE or IMMUTABLE
    // (the latter would ignore live WAL updates).
    const uri = `file:${this.dbPath.split("/").map(encodeURIComponent).join("/")}?mode=ro`;
    this.db = new Database(uri, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
    try {
      this.db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
      this.db.query("SELECT channel_id, ts, thread_ts, text FROM message LIMIT 0").all();
      this.db.query("SELECT key, value FROM state LIMIT 0").all();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close = (): void => this.db.close();

  private state = (key: string): string | null =>
    this.db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key=?").get(key)?.value ?? null;

  private snapshot = <T>(run: () => T): T => {
    this.db.exec("BEGIN;");
    try {
      return run();
    } finally {
      this.db.exec("ROLLBACK;");
    }
  };

  freshness = (): Freshness => {
    const schema = this.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema ORDER BY name").all();
    const schemaVersion =
      this.db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()?.schema_version ?? 0;
    const dataVersion = this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? 0;
    const lastSync = this.state("last_sync");
    const fileStamp = [this.dbPath, `${this.dbPath}-wal`].map((path) => {
      try {
        const stat = statSync(path);
        return `${stat.size}:${stat.mtimeMs}`;
      } catch {
        return "absent";
      }
    });
    return {
      fetched_at: new Date().toISOString(),
      last_sync: lastSync,
      asof: lastSync,
      db_fingerprint: createHash("sha256")
        .update(JSON.stringify([schema, fileStamp, lastSync]))
        .digest("hex"),
      schema_version: schemaVersion,
      data_version: dataVersion,
      source: "local_cache",
    };
  };

  metadata = () =>
    this.snapshot(() => ({
      freshness: this.freshness(),
      self_user: this.state("self_user"),
      base_url: this.state("base_url"),
      archive_floor_ts: this.state("archive_floor_ts"),
      channel_list: this.db
        .query<{ id: string; name: string; kind: string; history_ts: string }, []>(
          "SELECT id,name,kind,history_ts FROM channel ORDER BY id LIMIT 101",
        )
        .all()
        .slice(0, 100),
      channel_list_truncated: (this.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM channel").get()?.n ?? 0) > 100,
      scope: "Cached messages only; absence is not proof of no reply or task. No Slack refresh is performed.",
    }));

  search = (value: SearchInput) =>
    this.snapshot(() => {
      const input = parseSearch(value);
      const filter = ["deleted=0"];
      const bind: (string | number)[] = [];
      if (input.channel_id) {
        filter.push("channel_id=?");
        bind.push(input.channel_id);
      }
      if (input.user_id) {
        filter.push("user=?");
        bind.push(input.user_id);
      }
      if (input.since) {
        filter.push("ts>=?");
        bind.push(String(dateSecond(input.since, "since")));
      }
      if (input.until) {
        filter.push("ts<?");
        bind.push(String(dateSecond(input.until, "until")));
      }
      // The scan cap is separate from the hit cap. Do not promise complete
      // full-text search while using LIKE on an unindexed 400 MB archive.
      const candidateSql = `SELECT ${COLUMN} FROM message WHERE ${filter.join(" AND ")} ORDER BY ts DESC LIMIT ?`;
      const limit = input.limit ?? 20;
      const count =
        this.db
          .query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) n FROM (${candidateSql})`)
          .get(...bind, SCAN_MAX + 1)?.n ?? 0;
      const boundedColumn = COLUMN.replace("text,", "substr(text,1,600) text,");
      const hit = this.db
        .query<LocalMessage & { text_truncated: number }, (string | number)[]>(
          `WITH candidate AS MATERIALIZED (${candidateSql}) SELECT ${boundedColumn}, length(text)>600 text_truncated
         FROM candidate WHERE (?='' OR instr(lower(text),lower(?))>0) ORDER BY ts DESC LIMIT ?`,
        )
        .all(...bind, SCAN_MAX, input.query ?? "", input.query ?? "", limit + 1);
      return {
        freshness: this.freshness(),
        message_list: hit.slice(0, limit).map((msg) => ({ ...msg, text_truncated: Boolean(msg.text_truncated) })),
        hit_limit_reached: hit.length > limit,
        scanned_count: Math.min(count, SCAN_MAX),
        scan_truncated: count > SCAN_MAX,
        scope:
          "Latest 20000 matching metadata rows; literal substring (SQLite lower, ASCII case-insensitive), not SQL or Slack search syntax.",
      };
    });

  thread = (value: { channel_id: string; root_ts: string }): ThreadResult =>
    this.snapshot(() => {
      const { channel_id: channel, root_ts: rootTs } = parseThread(value);
      const root = this.db
        .query<LocalMessage, [string, string]>(`SELECT ${COLUMN} FROM message WHERE channel_id=? AND ts=?`)
        .get(channel, rootTs);
      if (!root)
        throw new Error("Thread root is not cached. Sync the inbox separately; local analysis never refreshes Slack.");
      if (root.thread_ts !== rootTs) throw new Error("Requested timestamp is a reply, not a thread root.");
      if (root.text.length > CONTEXT_MAX)
        throw new Error("Thread root exceeds the context budget; refusing to truncate the root.");
      const cachedCount =
        this.db
          .query<{ n: number }, [string, string, string]>(
            "SELECT COUNT(*) n FROM message WHERE channel_id=? AND (thread_ts=? OR ts=?)",
          )
          .get(channel, rootTs, rootTs)?.n ?? 0;
      const tail = this.db
        .query<LocalMessage, [string, string, string, number]>(
          `SELECT ${COLUMN} FROM message WHERE channel_id=? AND thread_ts=? AND ts<>? ORDER BY ts DESC LIMIT ?`,
        )
        .all(channel, rootTs, rootTs, MESSAGE_MAX);
      const selected: LocalMessage[] = [root];
      let size = root.text.length;
      for (const msg of tail) {
        if (size + msg.text.length + 200 > CONTEXT_MAX) continue;
        selected.push(msg);
        size += msg.text.length + 200;
      }
      selected.sort((a, b) => a.ts.localeCompare(b.ts));
      const selectedId = new Set(selected.map((msg) => msg.ts));
      const idList = this.db
        .query<{ ts: string }, [string, string, string, number]>(
          "SELECT ts FROM message WHERE channel_id=? AND (thread_ts=? OR ts=?) ORDER BY ts LIMIT ?",
        )
        .all(channel, rootTs, rootTs, SCAN_MAX)
        .map((row) => row.ts)
        .filter((ts) => !selectedId.has(ts));
      const omittedCount = cachedCount - selected.length;
      const info = this.db
        .query<{ fetched_at: number }, [string, string]>(
          "SELECT fetched_at FROM thread WHERE channel_id=? AND root_ts=?",
        )
        .get(channel, rootTs);
      const latestCached = selected.at(-1)?.ts ?? rootTs;
      const cacheIncomplete =
        cachedCount - 1 < root.reply_count ||
        (!info?.fetched_at && root.reply_count > 0) ||
        Boolean(root.latest_reply && latestCached < root.latest_reply) ||
        Boolean(root.deleted);
      const base = this.state("base_url");
      let url: string | null = null;
      if (base) {
        try {
          const parsed = new URL(base);
          if (parsed.protocol === "https:" && /^[a-z0-9-]+\.slack\.com$/.test(parsed.hostname)) {
            url = `${parsed.origin}/archives/${channel}/p${rootTs.replace(".", "")}`;
          }
        } catch {
          /* Metadata can exist before auth initialized the base URL. */
        }
      }
      return {
        freshness: this.freshness(),
        channel_id: channel,
        root_ts: rootTs,
        self_user: this.state("self_user"),
        url,
        thread_fetched_at: info?.fetched_at ?? null,
        root,
        message_list: selected,
        omitted_id_list: idList.slice(0, OMITTED_MAX),
        omitted_count: omittedCount,
        omitted_id_list_truncated: omittedCount > Math.min(idList.length, OMITTED_MAX),
        truncated: omittedCount > 0,
        needs_human: omittedCount > 0 || cacheIncomplete,
        cached_message_count: cachedCount,
        expected_reply_count: root.reply_count,
        cache_incomplete: cacheIncomplete,
      };
    });
}

export const openLocalStore = (option: { dbPath?: string } = {}): LocalStore => new LocalStore(option.dbPath);
