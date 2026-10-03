import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SlackMessage } from "../render";

export const DATA_DIR = join(homedir(), ".local", "share", "slack-cli");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS channel (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'public',
  is_member INTEGER NOT NULL DEFAULT 0,
  peer_user TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT 'normal',
  latest TEXT NOT NULL DEFAULT '',
  last_read TEXT NOT NULL DEFAULT '',
  history_ts TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS message (
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  user TEXT NOT NULL DEFAULT '',
  bot INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  edited_ts TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  latest_reply TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, ts)
);
CREATE INDEX IF NOT EXISTS message_thread ON message (channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS message_ts ON message (ts);
CREATE TABLE IF NOT EXISTS thread (
  channel_id TEXT NOT NULL,
  root_ts TEXT NOT NULL,
  followed INTEGER NOT NULL DEFAULT 0,
  last_read TEXT NOT NULL DEFAULT '',
  latest_reply TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, root_ts)
);
CREATE TABLE IF NOT EXISTS item (
  channel_id TEXT NOT NULL,
  root_ts TEXT NOT NULL,
  tier INTEGER NOT NULL,
  reason TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  mine_ts TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  ack_seq INTEGER NOT NULL DEFAULT 0,
  ack_ts TEXT NOT NULL DEFAULT '',
  reactivated INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, root_ts)
);
CREATE TABLE IF NOT EXISTS day_count (
  channel_id TEXT NOT NULL,
  day TEXT NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (channel_id, day)
);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface ChannelRow {
  id: string;
  name: string;
  /** public | private | mpim | im */
  kind: string;
  is_member: number;
  peer_user: string;
  /** dm | watch | normal | bot | mute */
  grade: string;
  latest: string;
  last_read: string;
  history_ts: string;
}

export interface MessageRow {
  channel_id: string;
  ts: string;
  thread_ts: string;
  user: string;
  bot: number;
  text: string;
  edited_ts: string;
  deleted: number;
  reply_count: number;
  latest_reply: string;
  body: string;
  seen_at: number;
}

export interface ItemRow {
  channel_id: string;
  root_ts: string;
  tier: number;
  reason: string;
  last_ts: string;
  mine_ts: string;
  seq: number;
  ack_seq: number;
  ack_ts: string;
  reactivated: number;
  edited: number;
}

/** One message from any source (search, history, replies), reduced to what the inbox keeps. */
export interface RawMessage {
  channelId: string;
  ts: string;
  /** equals ts for a top-level message */
  threadTs: string;
  user: string;
  bot: boolean;
  text: string;
  editedTs: string;
  replyCount: number;
  latestReply: string;
  body: SlackMessage;
}

export type UpsertResult = "new" | "changed" | "same";

export const openStore = (fileName: string): Database => {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(join(DATA_DIR, fileName), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000;");
  db.exec(SCHEMA);
  return db;
};

export const getState = (db: Database, key: string): string | undefined => {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM state WHERE key = ?").get(key);
  return row?.value;
};

export const setState = (db: Database, key: string, value: string): void => {
  db.query("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
};

export const nextSeq = (db: Database, key: string): number => {
  const next = Number(getState(db, key) ?? "0") + 1;
  setState(db, key, String(next));
  return next;
};

export const getChannel = (db: Database, id: string): ChannelRow | undefined => {
  return db.query<ChannelRow, [string]>("SELECT * FROM channel WHERE id = ?").get(id) ?? undefined;
};

export const ensureChannel = (db: Database, id: string, name: string, kind: string, peerUser = ""): void => {
  db.query(
    `INSERT INTO channel (id, name, kind, peer_user) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE channel.name END,
       kind = excluded.kind,
       peer_user = CASE WHEN excluded.peer_user <> '' THEN excluded.peer_user ELSE channel.peer_user END`,
  ).run(id, name, kind, peerUser);
};

/**
 * Store a message. Search results carry no edit marker and render text slightly
 * differently, so only history and replies may report a change; a search hit on
 * a known message is a no-op.
 */
export const upsertMessage = (db: Database, msg: RawMessage, authoritative: boolean): UpsertResult => {
  const old = db
    .query<MessageRow, [string, string]>("SELECT * FROM message WHERE channel_id = ? AND ts = ?")
    .get(msg.channelId, msg.ts);
  const body = JSON.stringify(msg.body);
  if (!old) {
    db.query(
      `INSERT INTO message (channel_id, ts, thread_ts, user, bot, text, edited_ts, reply_count, latest_reply, body, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      msg.channelId,
      msg.ts,
      msg.threadTs,
      msg.user,
      msg.bot ? 1 : 0,
      msg.text,
      msg.editedTs,
      msg.replyCount,
      msg.latestReply,
      body,
      Date.now(),
    );
    return "new";
  }
  if (!authoritative) return "same";
  const changed = old.text !== msg.text || old.edited_ts !== msg.editedTs || old.deleted === 1;
  db.query(
    `UPDATE message SET thread_ts = ?, user = ?, bot = ?, text = ?, edited_ts = ?, deleted = 0,
       reply_count = ?, latest_reply = ?, body = ? WHERE channel_id = ? AND ts = ?`,
  ).run(
    msg.threadTs,
    msg.user,
    msg.bot ? 1 : 0,
    msg.text,
    msg.editedTs,
    msg.replyCount,
    msg.latestReply,
    body,
    msg.channelId,
    msg.ts,
  );
  // a first fetch through history fills in what search left out; that is not an edit
  return changed && (old.edited_ts !== msg.editedTs || old.deleted === 1) ? "changed" : "same";
};

export const markDeleted = (db: Database, channelId: string, tsList: string[]): number => {
  let count = 0;
  for (const ts of tsList) {
    count += db
      .query("UPDATE message SET deleted = 1 WHERE channel_id = ? AND ts = ? AND deleted = 0")
      .run(channelId, ts).changes;
  }
  return count;
};
