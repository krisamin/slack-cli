import type { Database } from "bun:sqlite";
import { SlackApiError, slackApi } from "../api";
import type { Profile } from "../config";
import type { SlackMessage } from "../render";
import type { UserResolver } from "../users";
import { buildNameRe, classify, type Self } from "./classify";
import { explicitGrade, type InboxSetting } from "./setting";
import {
  type ChannelRow,
  ensureChannel,
  getChannel,
  getState,
  type ItemRow,
  markDeleted,
  nextSeq,
  type RawMessage,
  setState,
  upsertMessage,
} from "./store";

export interface InboxMessage extends SlackMessage {
  edited?: { ts?: string };
  subscribed?: boolean;
  last_read?: string;
}

interface SearchChannel {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  user?: string;
}

interface SearchMatch extends SlackMessage {
  channel: SearchChannel;
  permalink: string;
}

interface SearchResponse {
  ok: boolean;
  messages: { total: number; matches: SearchMatch[]; paging: { page: number; pages: number } };
}

interface PageResponse {
  ok: boolean;
  messages: InboxMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface CountEntry {
  id: string;
  last_read: string;
  latest: string;
  has_unreads: boolean;
  mention_count: number;
}

interface CountsResponse {
  ok: boolean;
  channels: CountEntry[];
  mpims: CountEntry[];
  ims: CountEntry[];
}

interface ViewResponse {
  ok: boolean;
  threads: { root_msg: InboxMessage & { channel: string } }[];
}

interface ConversationsResponse {
  ok: boolean;
  channels: {
    id: string;
    name?: string;
    is_im?: boolean;
    is_mpim?: boolean;
    is_private?: boolean;
    user?: string;
  }[];
  response_metadata?: { next_cursor?: string };
}

interface GroupsResponse {
  ok: boolean;
  usergroups: { id: string; handle: string; users?: string[] }[];
}

interface AuthResponse {
  ok: boolean;
  user_id: string;
  url: string;
}

export interface SyncReport {
  searched: number;
  historyChannel: number;
  threadFetched: number;
  newMessage: number;
  changedMessage: number;
  deletedMessage: number;
  bumped: number;
  gapList: string[];
  noteList: string[];
}

export interface Collector {
  profile: Profile;
  db: Database;
  resolver: UserResolver;
  setting: InboxSetting;
  self: Self;
  /** messages older than this never raise an item; they are context */
  floorTs: number;
  /** everything since this is stored, item or not */
  archiveFloorTs: number;
  report: SyncReport;
  /** threads already re-read in this run */
  fetchedThread: Set<string>;
}

const SEARCH_PAGE_LIMIT = 100;
const SEARCH_PAGE_SIZE = 100;
const META_TTL_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

export const emptyReport = (): SyncReport => ({
  searched: 0,
  historyChannel: 0,
  threadFetched: 0,
  newMessage: 0,
  changedMessage: 0,
  deletedMessage: 0,
  bumped: 0,
  gapList: [],
  noteList: [],
});

export const isAuthError = (err: unknown): boolean => {
  return err instanceof SlackApiError && /invalid_auth|not_authed|token_revoked|account_inactive/.test(err.code);
};

/** Local calendar day (the machine's zone), as Slack search date filters read it. */
export const localDay = (ms: number): string => {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const threadKey = (channelId: string, ts: string): string => `${channelId}:${ts}`;

const messageText = (msg: SlackMessage): string => {
  // alert bots often leave text empty and put everything in attachments
  const extra = (msg.attachments ?? [])
    .map((att) => [att.title, att.text ?? att.fallback].filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n");
  return [msg.text ?? "", extra].filter(Boolean).join("\n");
};

const slimBody = (msg: SlackMessage): SlackMessage => ({
  ts: msg.ts,
  ...(msg.user ? { user: msg.user } : {}),
  ...(msg.bot_id ? { bot_id: msg.bot_id } : {}),
  ...(msg.username ? { username: msg.username } : {}),
  ...(msg.subtype ? { subtype: msg.subtype } : {}),
  ...(msg.thread_ts ? { thread_ts: msg.thread_ts } : {}),
  text: msg.text ?? "",
  ...(msg.files?.length ? { files: msg.files.map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype })) } : {}),
  ...(msg.attachments?.length
    ? {
        attachments: msg.attachments.map((att) => ({
          title: att.title,
          fallback: att.fallback,
          text: att.text?.slice(0, 500),
        })),
      }
    : {}),
});

const toRaw = (channelId: string, msg: InboxMessage, threadTs?: string): RawMessage => ({
  channelId,
  ts: msg.ts,
  threadTs: threadTs ?? msg.thread_ts ?? msg.ts,
  user: msg.user ?? msg.bot_id ?? "",
  bot: Boolean(msg.bot_id) || msg.subtype === "bot_message",
  text: messageText(msg),
  editedTs: msg.edited?.ts ?? "",
  replyCount: msg.reply_count ?? 0,
  latestReply: msg.latest_reply ?? "",
  body: slimBody(msg),
});

const kindOf = (c: SearchChannel): string => {
  if (c.is_im) return "im";
  if (c.is_mpim) return "mpim";
  return c.is_private ? "private" : "public";
};

// ---------------------------------------------------------------- meta

/** Who you are, which groups you are in, which channels you are in. Refreshed every few hours. */
export const refreshMeta = async (col: Collector, force: boolean): Promise<void> => {
  const { db, profile } = col;
  const auth = await slackApi<AuthResponse>(profile, "auth.test");
  setState(db, "self_user", auth.user_id);
  setState(db, "base_url", auth.url.replace(/\/$/, ""));
  const last = Number(getState(db, "meta_at") ?? "0");
  if (!force && Date.now() - last < META_TTL_MS) return;

  const groups = await slackApi<GroupsResponse>(profile, "usergroups.list", { include_users: "true" });
  const groupMap: Record<string, string> = {};
  for (const group of groups.usergroups) {
    if (group.users?.includes(auth.user_id)) groupMap[group.id] = group.handle;
  }
  setState(db, "group_map", JSON.stringify(groupMap));

  const memberIdSet = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: "true",
      limit: "1000",
    };
    if (cursor) params.cursor = cursor;
    const res = await slackApi<ConversationsResponse>(profile, "users.conversations", params);
    for (const c of res.channels) {
      memberIdSet.add(c.id);
      ensureChannel(db, c.id, c.name ?? c.user ?? "", kindOf(c), c.user ?? "");
    }
    cursor = res.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  db.query("UPDATE channel SET is_member = 0").run();
  const setMember = db.query("UPDATE channel SET is_member = 1 WHERE id = ?");
  for (const id of memberIdSet) setMember.run(id);
  regrade(col);
  setState(db, "meta_at", String(Date.now()));
};

export const loadSelf = (db: Database, setting: InboxSetting): Self => ({
  userId: getState(db, "self_user") ?? "",
  groupMap: JSON.parse(getState(db, "group_map") ?? "{}") as Record<string, string>,
  nameRe: buildNameRe(setting.nameList),
});

/** Settings first, then the bot share of the last 7 days decides bot vs normal. */
export const regrade = (col: Collector): void => {
  const { db, setting } = col;
  const since = ((Date.now() - 7 * DAY_MS) / 1000).toFixed(6);
  const statList = db
    .query<{ channel_id: string; total: number; bots: number }, [string]>(
      "SELECT channel_id, COUNT(*) AS total, SUM(bot) AS bots FROM message WHERE ts >= ? GROUP BY channel_id",
    )
    .all(since);
  const statMap = new Map(statList.map((s) => [s.channel_id, s]));
  const update = db.query("UPDATE channel SET grade = ? WHERE id = ?");
  for (const channel of db.query<ChannelRow, []>("SELECT * FROM channel").all()) {
    let grade = explicitGrade(setting, channel.name);
    if (!grade && (channel.kind === "im" || channel.kind === "mpim")) grade = "dm";
    if (!grade) {
      const stat = statMap.get(channel.id);
      const human = stat ? (stat.total - stat.bots) / stat.total : 1;
      grade = stat && stat.total >= setting.botMinMessage && human < setting.botShare ? "bot" : "normal";
    }
    if (grade !== channel.grade) update.run(grade, channel.id);
  }
};

// ---------------------------------------------------------------- ingest + classify

interface InfoResponse {
  ok: boolean;
  channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string };
}

/** A channel we only met through a followed thread or a link: ask Slack what it is. */
const lookupChannel = async (col: Collector, channelId: string): Promise<ChannelRow | undefined> => {
  const known = getChannel(col.db, channelId);
  if (known) return known;
  try {
    const res = await slackApi<InfoResponse>(col.profile, "conversations.info", { channel: channelId });
    const c = res.channel;
    ensureChannel(col.db, channelId, c.name ?? c.user ?? "", kindOf(c), c.user ?? "");
  } catch (err) {
    if (isAuthError(err)) throw err;
    ensureChannel(col.db, channelId, "", "public");
  }
  return getChannel(col.db, channelId);
};

/**
 * Which item a message lands in. A thread is its own item; top-level chatter
 * in a DM or a watched channel collects into one item per channel, so a DM
 * conversation reads as one block instead of a line per message.
 */
export const CHANNEL_ROOT = "channel";

const itemRoot = (raw: RawMessage, channel: ChannelRow, reasonList: string[]): string => {
  if (raw.threadTs !== raw.ts || raw.replyCount > 0) return raw.threadTs;
  if (channel.kind === "im" || channel.kind === "mpim") return CHANNEL_ROOT;
  if (reasonList.length === 1 && reasonList[0] === "watch") return CHANNEL_ROOT;
  return raw.threadTs;
};

const isBotUser = async (col: Collector, raw: RawMessage): Promise<boolean> => {
  if (raw.bot) return true;
  if (!raw.user || raw.user.startsWith("B")) return raw.user.startsWith("B");
  return (await col.resolver.resolve(raw.user)).isBot;
};

const threadFact = (col: Collector, channelId: string, threadTs: string) => {
  const { db, self } = col;
  const participated = Boolean(
    db
      .query("SELECT 1 FROM message WHERE channel_id = ? AND thread_ts = ? AND user = ? AND deleted = 0 LIMIT 1")
      .get(channelId, threadTs, self.userId),
  );
  const thread = db
    .query<{ followed: number }, [string, string]>("SELECT followed FROM thread WHERE channel_id = ? AND root_ts = ?")
    .get(channelId, threadTs);
  const tracked = Boolean(
    db.query("SELECT 1 FROM item WHERE channel_id = ? AND root_ts = ? AND tier = 1").get(channelId, threadTs),
  );
  return { participated, followed: thread?.followed === 1, tracked };
};

const bump = (
  col: Collector,
  raw: RawMessage,
  root: string,
  tier: number,
  reasonList: string[],
  flag: { edited: boolean; mine: boolean },
): void => {
  const { db } = col;
  const key = [raw.channelId, root] as const;
  const old = db
    .query<ItemRow, [string, string]>("SELECT * FROM item WHERE channel_id = ? AND root_ts = ?")
    .get(...key);
  if (flag.mine) {
    // your own reply never wakes anyone, but it lets the reader close the item
    if (!old) return;
    const seq = nextSeq(db, "item_seq");
    db.query("UPDATE item SET mine_ts = MAX(mine_ts, ?), seq = ? WHERE channel_id = ? AND root_ts = ?").run(
      raw.ts,
      seq,
      ...key,
    );
    return;
  }
  const seq = nextSeq(db, "item_seq");
  setState(db, "wake_seq", String(seq));
  const reactivated = raw.threadTs !== raw.ts && Number(raw.ts) - Number(raw.threadTs) > 86_400 ? 1 : 0;
  if (!old) {
    db.query(
      `INSERT INTO item (channel_id, root_ts, tier, reason, last_ts, seq, reactivated, edited)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...key, tier, reasonList.join(","), raw.ts, seq, reactivated, flag.edited ? 1 : 0);
  } else {
    const settled = old.ack_seq >= old.seq;
    const reasonSet = new Set(settled ? [] : old.reason.split(",").filter(Boolean));
    for (const r of reasonList) reasonSet.add(r);
    const newTier = settled ? tier : Math.min(old.tier, tier);
    db.query(
      `UPDATE item SET tier = ?, reason = ?, last_ts = MAX(last_ts, ?), seq = ?,
         reactivated = ?, edited = ? WHERE channel_id = ? AND root_ts = ?`,
    ).run(
      newTier,
      [...reasonSet].join(","),
      raw.ts,
      seq,
      settled ? reactivated : Math.max(old.reactivated, reactivated),
      settled ? (flag.edited ? 1 : 0) : Math.max(old.edited, flag.edited ? 1 : 0),
      ...key,
    );
  }
  col.report.bumped++;
};

/**
 * Store a batch, then classify what is new or edited. Returns the threads that
 * deserve a full re-read: relevant replies, and replies in threads we have
 * never seen (to learn whether you took part).
 */
export const ingest = async (
  col: Collector,
  rawList: RawMessage[],
  authoritative: boolean,
): Promise<Map<string, [string, string]>> => {
  const { db, report } = col;
  const fresh: { raw: RawMessage; edited: boolean }[] = [];
  db.exec("BEGIN");
  try {
    for (const raw of rawList) {
      raw.bot = await isBotUser(col, raw);
      const result = upsertMessage(db, raw, authoritative);
      if (result === "new") report.newMessage++;
      if (result === "changed") report.changedMessage++;
      if (result !== "same") fresh.push({ raw, edited: result === "changed" });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const wanted = new Map<string, [string, string]>();
  fresh.sort((a, b) => Number(a.raw.ts) - Number(b.raw.ts));
  for (const { raw, edited } of fresh) {
    if (Number(raw.ts) * 1000 < col.floorTs) continue;
    const channel = await lookupChannel(col, raw.channelId);
    if (!channel) continue;
    const fact = threadFact(col, raw.channelId, raw.threadTs);
    const verdict = classify(col.self, raw, channel, fact);
    const isThread = raw.threadTs !== raw.ts || raw.replyCount > 0;
    const known = db
      .query("SELECT fetched_at FROM thread WHERE channel_id = ? AND root_ts = ?")
      .get(raw.channelId, raw.threadTs);
    if (verdict.mine) {
      bump(col, raw, itemRoot(raw, channel, []), 0, [], { edited, mine: true });
      if (isThread) wanted.set(threadKey(raw.channelId, raw.threadTs), [raw.channelId, raw.threadTs]);
      continue;
    }
    if (verdict.tier > 0) {
      bump(
        col,
        raw,
        itemRoot(raw, channel, verdict.reasonList),
        verdict.tier,
        edited ? [...verdict.reasonList, "edited"] : verdict.reasonList,
        {
          edited,
          mine: false,
        },
      );
      if (isThread) wanted.set(threadKey(raw.channelId, raw.threadTs), [raw.channelId, raw.threadTs]);
    } else if (
      raw.threadTs !== raw.ts &&
      !known &&
      channel.is_member === 1 &&
      (channel.grade === "normal" || channel.grade === "watch")
    ) {
      // a reply under a root we never read: fetch once to see whether you are in it
      wanted.set(threadKey(raw.channelId, raw.threadTs), [raw.channelId, raw.threadTs]);
    }
  }
  return wanted;
};

// ---------------------------------------------------------------- threads

/** Replies of one thread. `complete` is false when the page cap cut it short. */
export const fetchReplies = async (
  col: Collector,
  channelId: string,
  rootTs: string,
  maxPage = 20,
): Promise<{ messages: InboxMessage[]; complete: boolean }> => {
  const messages: InboxMessage[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < maxPage; page++) {
    const params: Record<string, string> = { channel: channelId, ts: rootTs, limit: "200" };
    if (cursor) params.cursor = cursor;
    const res = await slackApi<PageResponse>(col.profile, "conversations.replies", params);
    messages.push(...res.messages);
    cursor = res.response_metadata?.next_cursor;
    if (!res.has_more || !cursor) {
      complete = true;
      break;
    }
  }
  return { messages, complete };
};

/** Re-read whole threads: new replies, edits, and deletions (gone from the reply list). */
export const refreshThreadList = async (
  col: Collector,
  threadList: [string, string][],
  budget = 60,
  maxPage = 20,
): Promise<void> => {
  let queue = threadList;
  const startSize = col.fetchedThread.size;
  for (let round = 0; round < 3 && queue.length; round++) {
    const next = new Map<string, [string, string]>();
    for (const [channelId, rootTs] of queue) {
      const key = threadKey(channelId, rootTs);
      if (col.fetchedThread.has(key)) continue;
      if (col.fetchedThread.size - startSize >= budget) {
        col.report.noteList.push(`thread budget ${budget} reached; rest next run`);
        return;
      }
      col.fetchedThread.add(key);
      let messages: InboxMessage[];
      let complete: boolean;
      try {
        ({ messages, complete } = await fetchReplies(col, channelId, rootTs, maxPage));
      } catch (err) {
        if (isAuthError(err)) throw err;
        const code = err instanceof SlackApiError ? err.code : String(err);
        if (code === "thread_not_found") {
          col.report.deletedMessage += markDeleted(col.db, channelId, [rootTs]);
        } else {
          col.report.noteList.push(`replies ${channelId}/${rootTs}: ${code}`);
        }
        continue;
      }
      col.report.threadFetched++;
      const root = messages[0];
      // a thread cut short by the page cap says nothing about what is missing
      if (complete) {
        const seenTsSet = new Set(messages.map((m) => m.ts));
        const goneList = col.db
          .query<{ ts: string }, [string, string]>(
            "SELECT ts FROM message WHERE channel_id = ? AND thread_ts = ? AND deleted = 0",
          )
          .all(channelId, rootTs)
          .map((r) => r.ts)
          .filter((ts) => !seenTsSet.has(ts));
        col.report.deletedMessage += markDeleted(col.db, channelId, goneList);
      } else {
        col.report.noteList.push(`thread ${channelId}/${rootTs} over ${messages.length} replies, read partly`);
      }
      col.db
        .query(
          `INSERT INTO thread (channel_id, root_ts, followed, last_read, latest_reply, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, root_ts) DO UPDATE SET followed = excluded.followed, last_read = excluded.last_read,
             latest_reply = excluded.latest_reply, fetched_at = excluded.fetched_at`,
        )
        .run(channelId, rootTs, root?.subscribed ? 1 : 0, root?.last_read ?? "", root?.latest_reply ?? "", Date.now());
      const wanted = await ingest(
        col,
        messages.map((m) => toRaw(channelId, m, rootTs)),
        true,
      );
      for (const [k, v] of wanted) if (!col.fetchedThread.has(k)) next.set(k, v);
    }
    queue = [...next.values()];
  }
};

// ---------------------------------------------------------------- search

const runSearch = async (col: Collector, query: string, page: number): Promise<SearchResponse["messages"]> => {
  const res = await slackApi<SearchResponse>(col.profile, "search.messages", {
    query,
    sort: "timestamp",
    sort_dir: "desc",
    count: String(SEARCH_PAGE_SIZE),
    page: String(page),
  });
  return res.messages;
};

const searchToRaw = (col: Collector, match: SearchMatch): RawMessage => {
  const c = match.channel;
  const kind = kindOf(c);
  if (!getChannel(col.db, c.id)) ensureChannel(col.db, c.id, c.name ?? "", kind, c.user ?? "");
  const threadTs = match.permalink.match(/thread_ts=([0-9.]+)/)?.[1];
  return toRaw(c.id, match, threadTs);
};

/**
 * Page a query newest-first down to `sinceTs`. Slack stops at page 100
 * (10,000 hits) and then quietly serves page 1 again, so a page number that
 * does not match means we hit the wall; the caller learns how far we got.
 */
export const searchDown = async (
  col: Collector,
  query: string,
  sinceTs: number,
): Promise<{ wanted: Map<string, [string, string]>; reachedTs: number; complete: boolean; total: number }> => {
  const wanted = new Map<string, [string, string]>();
  let reachedTs = Number.POSITIVE_INFINITY;
  let total = 0;
  for (let page = 1; page <= SEARCH_PAGE_LIMIT; page++) {
    const res = await runSearch(col, query, page);
    total = res.total;
    if (res.paging.page !== page) return { wanted, reachedTs, complete: false, total };
    const rawList: RawMessage[] = [];
    let done = false;
    for (const match of res.matches) {
      const ts = Number(match.ts);
      if (ts < sinceTs) {
        done = true;
        continue;
      }
      reachedTs = Math.min(reachedTs, ts);
      rawList.push(searchToRaw(col, match));
    }
    col.report.searched += rawList.length;
    for (const [k, v] of await ingest(col, rawList, false)) wanted.set(k, v);
    if (done || res.matches.length < SEARCH_PAGE_SIZE) return { wanted, reachedTs, complete: true, total };
  }
  return { wanted, reachedTs, complete: false, total };
};

/**
 * Fill a stretch that is too busy for one search: per local day, excluding the
 * loudest channels until the day fits under the page wall. Excluded channels
 * are counted, and member channels among them are read through history.
 */
export const fillRange = async (
  col: Collector,
  fromTs: number,
  toTs: number,
): Promise<{ wanted: Map<string, [string, string]>; excludedIdSet: Set<string> }> => {
  const wanted = new Map<string, [string, string]>();
  const excludedIdSet = new Set<string>();
  const botIdList = col.db
    .query<{ id: string }, []>("SELECT id FROM channel WHERE grade IN ('bot', 'mute')")
    .all()
    .map((r) => r.id);
  for (let dayMs = fromTs * 1000; dayMs <= toTs * 1000 + DAY_MS; dayMs += DAY_MS) {
    const day = localDay(dayMs);
    const dayStart = new Date(`${day}T00:00:00`).getTime() / 1000;
    if (dayStart > toTs) break;
    const exclude = new Set(botIdList);
    let query = "";
    for (let round = 0; round < 60; round++) {
      query = [`on:${day}`, ...[...exclude].map((id) => `-in:<#${id}>`)].join(" ");
      const first = await runSearch(col, query, 1);
      if (first.total <= SEARCH_PAGE_LIMIT * SEARCH_PAGE_SIZE - 50) break;
      const countMap = new Map<string, number>();
      for (const m of first.matches) countMap.set(m.channel.id, (countMap.get(m.channel.id) ?? 0) + 1);
      const loudest = [...countMap].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!loudest) break;
      if (!getChannel(col.db, loudest)) {
        const m = first.matches.find((x) => x.channel.id === loudest);
        if (m) ensureChannel(col.db, loudest, m.channel.name ?? "", kindOf(m.channel), m.channel.user ?? "");
      }
      exclude.add(loudest);
    }
    for (const id of exclude) excludedIdSet.add(id);
    const result = await searchDown(col, query, Math.max(fromTs, dayStart));
    for (const [k, v] of result.wanted) wanted.set(k, v);
    if (!result.complete) col.report.gapList.push(`${day}: still over the search wall after exclusions`);
    for (const id of exclude) {
      const counted = await runSearch(col, `on:${day} in:<#${id}>`, 1);
      col.db
        .query(
          "INSERT INTO day_count (channel_id, day, total) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET total = excluded.total",
        )
        .run(id, day, counted.total);
    }
  }
  return { wanted, excludedIdSet };
};

// ---------------------------------------------------------------- history

const fetchHistory = async (
  col: Collector,
  channelId: string,
  oldest: string,
  maxPage: number,
): Promise<InboxMessage[]> => {
  const messages: InboxMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPage; page++) {
    const params: Record<string, string> = { channel: channelId, oldest, inclusive: "true", limit: "200" };
    if (cursor) params.cursor = cursor;
    const res = await slackApi<PageResponse>(col.profile, "conversations.history", params);
    messages.push(...res.messages);
    cursor = res.response_metadata?.next_cursor;
    if (!res.has_more || !cursor) break;
  }
  return messages;
};

/**
 * Read a channel from `oldestTs` on. Catches what search has not indexed yet,
 * picks up edits, and flags top-level messages that vanished as deleted.
 */
export const readChannel = async (
  col: Collector,
  channelId: string,
  oldestTs: number,
  archive = false,
): Promise<Map<string, [string, string]>> => {
  const oldest = oldestTs.toFixed(6);
  let messages: InboxMessage[];
  try {
    messages = await fetchHistory(col, channelId, oldest, archive ? 500 : 50);
  } catch (err) {
    if (isAuthError(err)) throw err;
    col.report.noteList.push(`history ${channelId}: ${err instanceof SlackApiError ? err.code : String(err)}`);
    return new Map();
  }
  col.report.historyChannel++;
  const seenTsSet = new Set(messages.map((m) => m.ts));
  const goneList = col.db
    .query<{ ts: string }, [string, string]>(
      "SELECT ts FROM message WHERE channel_id = ? AND ts >= ? AND thread_ts = ts AND deleted = 0",
    )
    .all(channelId, oldest)
    .map((r) => r.ts)
    .filter((ts) => !seenTsSet.has(ts));
  col.report.deletedMessage += markDeleted(col.db, channelId, goneList);
  const wanted = await ingest(
    col,
    messages.map((m) => toRaw(channelId, m)),
    true,
  );
  // roots whose reply list moved since we last read them
  for (const m of messages) {
    if (!m.reply_count) continue;
    const thread = col.db
      .query<{ latest_reply: string }, [string, string]>(
        "SELECT latest_reply FROM thread WHERE channel_id = ? AND root_ts = ?",
      )
      .get(channelId, m.ts);
    const channel = getChannel(col.db, channelId);
    // Every thread is archived; only bot threads (often thousands of replies a day)
    // are left to search for their new replies after the first full read.
    const caresAbout =
      archive ||
      (channel?.grade !== "bot" && channel?.grade !== "mute") ||
      m.subscribed === true ||
      Boolean(col.db.query("SELECT 1 FROM item WHERE channel_id = ? AND root_ts = ?").get(channelId, m.ts));
    if (caresAbout && (!thread || thread.latest_reply !== (m.latest_reply ?? ""))) {
      wanted.set(threadKey(channelId, m.ts), [channelId, m.ts]);
    }
  }
  return wanted;
};

// ---------------------------------------------------------------- counts + followed threads

/** Channels whose latest message moved since last time; quiet grades are skipped. */
export const changedChannelList = async (col: Collector): Promise<{ id: string; since: number }[]> => {
  const res = await slackApi<CountsResponse>(col.profile, "client.counts", { thread_counts_by_channel: "true" });
  const out: { id: string; since: number }[] = [];
  const update = col.db.query("UPDATE channel SET latest = ?, last_read = ? WHERE id = ?");
  for (const entry of [...res.channels, ...res.mpims, ...res.ims]) {
    const channel = getChannel(col.db, entry.id);
    if (!channel) continue;
    const moved = entry.latest > channel.latest;
    update.run(entry.latest, entry.last_read, entry.id);
    if (!moved) continue;
    const floor = col.archiveFloorTs / 1000;
    const fromTs = channel.history_ts ? Number(channel.history_ts) - col.setting.overlapSecond : floor;
    out.push({ id: entry.id, since: Math.max(fromTs, floor) });
  }
  return out;
};

/** Threads you follow whose newest reply we have not read yet. */
export const followedThreadList = async (col: Collector): Promise<[string, string][]> => {
  const res = await slackApi<ViewResponse>(col.profile, "subscriptions.thread.getView", { limit: "50" });
  const out: [string, string][] = [];
  for (const { root_msg: root } of res.threads) {
    const known = col.db
      .query<{ latest_reply: string }, [string, string]>(
        "SELECT latest_reply FROM thread WHERE channel_id = ? AND root_ts = ?",
      )
      .get(root.channel, root.ts);
    col.db
      .query(
        `INSERT INTO thread (channel_id, root_ts, followed) VALUES (?, ?, 1)
         ON CONFLICT(channel_id, root_ts) DO UPDATE SET followed = 1`,
      )
      .run(root.channel, root.ts);
    if (!known || known.latest_reply !== (root.latest_reply ?? "")) out.push([root.channel, root.ts]);
  }
  return out;
};
