import type { Database } from "bun:sqlite";
import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Profile, resolveProfile } from "../config";
import { UserResolver } from "../users";
import {
  type Collector,
  changedChannelList,
  emptyReport,
  fillRange,
  followedThreadList,
  isAuthError,
  loadSelf,
  localDay,
  readChannel,
  refreshMeta,
  refreshThreadList,
  regrade,
  searchDown,
} from "./collect";
import { type InboxSetting, loadSetting } from "./setting";
import { DATA_DIR, getState, openStore, setState } from "./store";

export interface Inbox {
  profileName: string;
  profile: Profile;
  db: Database;
  setting: InboxSetting;
  resolver: UserResolver;
}

export const openInbox = async (profileOption?: string): Promise<Inbox> => {
  const config = await loadConfig();
  const { name, profile } = resolveProfile(config, profileOption);
  const fileName = name === config.default ? "inbox.db" : `inbox-${name}.db`;
  const db = openStore(fileName);
  const resolver = new UserResolver(profile, name);
  await resolver.load();
  return { profileName: name, profile, db, setting: await loadSetting(), resolver };
};

export const makeCollector = (inbox: Inbox): Collector => ({
  profile: inbox.profile,
  db: inbox.db,
  resolver: inbox.resolver,
  setting: inbox.setting,
  self: loadSelf(inbox.db, inbox.setting),
  floorTs: Number(getState(inbox.db, "floor_ts") ?? String(Date.now() - 86_400_000)),
  report: emptyReport(),
  fetchedThread: new Set(),
});

const LOCK_STALE_MS = 30 * 60_000;

/** One collector at a time: the 10-minute tick and a manual run must not interleave. */
const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const path = join(DATA_DIR, "inbox.lock");
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < LOCK_STALE_MS) throw new Error(`another inbox run holds ${path} (${Math.round(age / 1000)}s old)`);
    unlinkSync(path);
    fd = openSync(path, "wx");
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  try {
    return await fn();
  } finally {
    unlinkSync(path);
  }
};

const merge = (into: Map<string, [string, string]>, from: Map<string, [string, string]>): void => {
  for (const [k, v] of from) into.set(k, v);
};

const finish = (inbox: Inbox, col: Collector, startedAt: number): string => {
  regrade(col);
  setState(inbox.db, "auth", "ok");
  setState(inbox.db, "last_sync", String(startedAt));
  setState(inbox.db, "last_report", JSON.stringify(col.report));
  // bot chatter is only counted; drop its text after two weeks
  const cutoff = ((Date.now() - 14 * 86_400_000) / 1000).toFixed(6);
  inbox.db
    .query(
      `DELETE FROM message WHERE ts < ? AND channel_id IN (SELECT id FROM channel WHERE grade IN ('bot', 'mute'))
       AND NOT EXISTS (SELECT 1 FROM item WHERE item.channel_id = message.channel_id AND item.root_ts = message.thread_ts)`,
    )
    .run(cutoff);
  const r = col.report;
  const lineList = [
    `searched ${r.searched}, channels read ${r.historyChannel}, threads read ${r.threadFetched}`,
    `messages new ${r.newMessage}, edited ${r.changedMessage}, deleted ${r.deletedMessage}; items raised ${r.bumped}`,
  ];
  for (const gap of r.gapList) lineList.push(`gap: ${gap}`);
  for (const note of r.noteList.slice(0, 10)) lineList.push(`note: ${note}`);
  return lineList.join("\n");
};

const authFail = (inbox: Inbox, err: unknown): never => {
  setState(inbox.db, "auth", `fail ${new Date().toISOString()}`);
  throw err;
};

const incremental = async (inbox: Inbox, col: Collector, startedAt: number): Promise<void> => {
  const { db, setting } = inbox;
  const wanted = new Map<string, [string, string]>();
  const cursor = Number(getState(db, "search_ts") ?? String(col.floorTs / 1000));
  const sinceTs = Math.max(cursor - setting.overlapSecond, col.floorTs / 1000);
  const query = `after:${localDay((sinceTs - 86_400) * 1000)}`;
  const found = await searchDown(col, query, sinceTs);
  merge(wanted, found.wanted);
  if (!found.complete) {
    col.report.gapList.push(`search wall between ${localDay(sinceTs * 1000)} and ${localDay(found.reachedTs * 1000)}`);
    const filled = await fillRange(col, sinceTs, Math.min(found.reachedTs, startedAt));
    merge(wanted, filled.wanted);
  }
  setState(db, "search_ts", String(startedAt));

  for (const { id, since } of await changedChannelList(col)) {
    merge(wanted, await readChannel(col, id, since));
    db.query("UPDATE channel SET history_ts = ? WHERE id = ?").run(String(startedAt), id);
  }
  const followed = await followedThreadList(col);
  await refreshThreadList(col, [...wanted.values(), ...followed], 80);
};

export const sync = async (profileOption?: string): Promise<string> => {
  const inbox = await openInbox(profileOption);
  return withLock(async () => {
    const startedAt = Date.now() / 1000;
    const col = makeCollector(inbox);
    try {
      await refreshMeta(col, false);
      col.self = loadSelf(inbox.db, inbox.setting);
      if (!getState(inbox.db, "floor_ts")) setState(inbox.db, "floor_ts", String(col.floorTs));
      await incremental(inbox, col, startedAt);
    } catch (err) {
      if (isAuthError(err)) authFail(inbox, err);
      throw err;
    } finally {
      await inbox.resolver.save();
    }
    return finish(inbox, col, startedAt);
  });
};

/**
 * First run: read everything since `sinceMs`. Search per day (busy channels
 * excluded and counted), then targeted searches for you across the whole
 * range, then the normal incremental pass reads every non-bot channel you are
 * in through history and every thread that matters through replies.
 */
export const backfill = async (sinceMs: number, profileOption?: string): Promise<string> => {
  const inbox = await openInbox(profileOption);
  return withLock(async () => {
    const startedAt = Date.now() / 1000;
    setState(inbox.db, "floor_ts", String(sinceMs));
    const col = makeCollector(inbox);
    try {
      await refreshMeta(col, true);
      col.self = loadSelf(inbox.db, inbox.setting);
      const wanted = new Map<string, [string, string]>();
      const filled = await fillRange(col, sinceMs / 1000, startedAt);
      merge(wanted, filled.wanted);
      regrade(col);
      const after = `after:${localDay(sinceMs - 86_400_000)}`;
      const me = col.self.userId;
      const targeted = [
        `${after} <@${me}>`,
        `${after} from:<@${me}>`,
        `${after} to:me`,
        ...Object.keys(col.self.groupMap).map((id) => `${after} <!subteam^${id}>`),
        ...inbox.setting.nameList.map((name) => `${after} ${name}`),
      ];
      for (const query of targeted) {
        merge(wanted, (await searchDown(col, query, sinceMs / 1000)).wanted);
      }
      setState(inbox.db, "search_ts", String(startedAt));
      // reset channel marks so the incremental pass reads every channel from the floor
      inbox.db.query("UPDATE channel SET latest = '', history_ts = ''").run();
      await refreshThreadList(col, [...wanted.values()], 3000);
      await incremental(inbox, col, startedAt);
    } catch (err) {
      if (isAuthError(err)) authFail(inbox, err);
      throw err;
    } finally {
      await inbox.resolver.save();
    }
    return finish(inbox, col, startedAt);
  });
};
