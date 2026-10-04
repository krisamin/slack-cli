import { extractMentions, formatTs, header, renderMessage, type SlackMessage } from "../render";
import { CHANNEL_ROOT, isAuthError, loadSelf, refreshThreadList } from "./collect";
import { type Inbox, makeCollector, openInbox } from "./run";
import { type ChannelRow, getChannel, getState, type ItemRow, type MessageRow, setState } from "./store";

const THREAD_CONTEXT = 15;
const NEW_CAP = 80;

const permalink = (base: string, channelId: string, ts: string, threadTs?: string): string => {
  const link = `${base}/archives/${channelId}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${link}?thread_ts=${threadTs}&cid=${channelId}` : link;
};

/** Link to one message itself: replies carry thread_ts so Slack opens them in place. */
const messageLink = (base: string, m: MessageRow): string => permalink(base, m.channel_id, m.ts, m.thread_ts);

const channelLabel = async (inbox: Inbox, channel: ChannelRow | undefined, id: string): Promise<string> => {
  if (!channel) return id;
  if (channel.kind === "im") {
    const peer = channel.peer_user ? await inbox.resolver.resolve(channel.peer_user) : undefined;
    return `DM · ${peer ? peer.realName : channel.name}`;
  }
  if (channel.kind === "mpim") {
    const handleList = channel.name
      .replace(/^mpdm-/, "")
      .replace(/-\d+$/, "")
      .split("--")
      .filter(Boolean);
    return `group DM · ${handleList.join(", ")}`;
  }
  return `#${channel.name || id}`;
};

const itemMessageList = (inbox: Inbox, item: ItemRow): MessageRow[] => {
  if (item.root_ts === CHANNEL_ROOT) {
    const since = item.ack_ts || "0";
    const newer = inbox.db
      .query<MessageRow, [string, string]>(
        "SELECT * FROM message WHERE channel_id = ? AND thread_ts = ts AND ts > ? ORDER BY ts",
      )
      .all(item.channel_id, since);
    const before = inbox.db
      .query<MessageRow, [string, string, number]>(
        "SELECT * FROM message WHERE channel_id = ? AND thread_ts = ts AND ts <= ? ORDER BY ts DESC LIMIT ?",
      )
      .all(item.channel_id, since, 3)
      .reverse();
    return [...before, ...newer];
  }
  return inbox.db
    .query<MessageRow, [string, string]>("SELECT * FROM message WHERE channel_id = ? AND thread_ts = ? ORDER BY ts")
    .all(item.channel_id, item.root_ts);
};

/**
 * Did you answer outside the thread? People often reply in the channel body
 * instead of the thread, or answer "please check" with a reaction. Both count.
 */
const answeredElsewhere = (inbox: Inbox, item: ItemRow, self: string): { postTs: string; reactionList: string[] } => {
  const post = inbox.db
    .query<{ ts: string }, [string, string, string]>(
      "SELECT ts FROM message WHERE channel_id = ? AND user = ? AND ts > ? AND deleted = 0 ORDER BY ts LIMIT 1",
    )
    .get(item.channel_id, self, item.last_ts);
  const reactionSet = new Set<string>();
  for (const m of itemMessageList(inbox, item)) {
    const body = JSON.parse(m.body) as { reactions?: { name: string; users: string[] }[] };
    for (const r of body.reactions ?? []) if (r.users.includes(self)) reactionSet.add(r.name);
  }
  return { postTs: post?.ts ?? "", reactionList: [...reactionSet] };
};

export interface PendingOption {
  profile?: string;
  json: boolean;
  refresh: boolean;
  /** only items at or above this tier (1 = needs you) */
  tier: number;
  brief: boolean;
}

export const pendingItemList = (inbox: Inbox, tier: number): ItemRow[] => {
  return inbox.db
    .query<ItemRow, [number]>("SELECT * FROM item WHERE seq > ack_seq AND tier <= ? ORDER BY tier, last_ts")
    .all(tier);
};

/**
 * Everything not yet acknowledged, each with its whole thread (or the new part
 * of a DM / watched channel) so the reader needs no second lookup. Threads are
 * re-read first, so edits and deletions since collection show.
 */
export const pending = async (opts: PendingOption): Promise<string> => {
  const inbox = await openInbox(opts.profile);
  let itemList = pendingItemList(inbox, opts.tier);
  if (opts.refresh && itemList.length) {
    const col = makeCollector(inbox);
    col.self = loadSelf(inbox.db, inbox.setting);
    try {
      await refreshThreadList(
        col,
        itemList.filter((i) => i.root_ts !== CHANNEL_ROOT).map((i) => [i.channel_id, i.root_ts]),
        200,
      );
    } catch (err) {
      if (isAuthError(err)) setState(inbox.db, "auth", `fail ${new Date().toISOString()}`);
      throw err;
    }
    itemList = pendingItemList(inbox, opts.tier);
  }
  const base = getState(inbox.db, "base_url") ?? "";
  const upto = itemList.reduce((max, i) => Math.max(max, i.seq), 0);
  const self = getState(inbox.db, "self_user") ?? "";

  const blockList: { item: ItemRow; label: string; link: string; messageList: MessageRow[] }[] = [];
  for (const item of itemList) {
    const channel = getChannel(inbox.db, item.channel_id);
    const label = await channelLabel(inbox, channel, item.channel_id);
    const link =
      item.root_ts === CHANNEL_ROOT
        ? permalink(base, item.channel_id, item.last_ts)
        : permalink(base, item.channel_id, item.root_ts);
    blockList.push({ item, label, link, messageList: itemMessageList(inbox, item) });
  }

  if (opts.json) {
    await inbox.resolver.save();
    return JSON.stringify(
      {
        upto,
        itemList: blockList.map(({ item, label, link, messageList }) => ({
          key: `${item.channel_id}:${item.root_ts}`,
          tier: item.tier,
          reasonList: item.reason.split(",").filter(Boolean),
          channel: label,
          link,
          lastTs: item.last_ts,
          youRepliedTs: item.mine_ts || null,
          ...((elsewhere) => ({
            answered:
              (item.mine_ts !== "" && item.mine_ts >= item.last_ts) ||
              elsewhere.postTs !== "" ||
              elsewhere.reactionList.length > 0,
            youPostedInChannelTs: elsewhere.postTs || null,
            youReacted: elsewhere.reactionList,
          }))(answeredElsewhere(inbox, item, self)),
          reactivated: item.reactivated === 1,
          messageList: messageList.map((m) => ({
            ...(JSON.parse(m.body) as SlackMessage),
            permalink: messageLink(base, m),
            isNew: m.ts > item.ack_ts,
            deleted: m.deleted === 1,
          })),
        })),
      },
      null,
      2,
    );
  }

  const users = await inbox.resolver.resolveMany(
    extractMentions(blockList.flatMap((b) => b.messageList.map((m) => JSON.parse(m.body) as SlackMessage))),
  );
  await inbox.resolver.save();
  const lastSync = getState(inbox.db, "last_sync");
  const out: string[] = [
    header(
      `inbox · ${itemList.length} pending · upto ${upto} · synced ${lastSync ? formatTs(lastSync) : "never"} · auth ${getState(inbox.db, "auth") ?? "?"}`,
    ),
    "",
  ];
  let index = 0;
  for (const { item, label, link, messageList } of blockList) {
    index++;
    const elsewhere = answeredElsewhere(inbox, item, self);
    const flagList = [
      item.reason,
      item.reactivated ? "old thread revived" : "",
      item.edited ? "edited" : "",
      item.mine_ts
        ? `you replied ${formatTs(item.mine_ts)}${item.mine_ts >= item.last_ts ? " (last word yours)" : ""}`
        : "",
      elsewhere.postTs
        ? `you posted in channel ${formatTs(elsewhere.postTs)}${Number(elsewhere.postTs) - Number(item.last_ts) <= 1800 ? " (within 30m, likely answered)" : ""}`
        : "",
      elsewhere.reactionList.length ? `you reacted :${elsewhere.reactionList.join(": :")}:` : "",
    ].filter(Boolean);
    out.push(header(`[${index}] tier ${item.tier} · ${label} · ${flagList.join(" · ")}`));
    out.push(`key ${item.channel_id}:${item.root_ts} · ${link}`);
    if (opts.brief) {
      const last = [...messageList].reverse().find((m) => m.user !== self) ?? messageList.at(-1);
      if (last) out.push(renderMessage(JSON.parse(last.body) as SlackMessage, users), `  ↳ ${messageLink(base, last)}`);
      out.push("");
      continue;
    }
    const fresh = messageList.filter((m) => m.ts > item.ack_ts);
    const old = messageList.filter((m) => m.ts <= item.ack_ts);
    const root = item.root_ts !== CHANNEL_ROOT ? messageList[0] : undefined;
    const shownOld = old.slice(-THREAD_CONTEXT).filter((m) => m !== root);
    const skipped = old.length - shownOld.length - (root && old.includes(root) ? 1 : 0);
    const shownNew = fresh.slice(-NEW_CAP).filter((m) => m !== root);
    const renderRow = (m: MessageRow, isNew: boolean): string => {
      const text = renderMessage(JSON.parse(m.body) as SlackMessage, users);
      const tagList = [isNew ? "NEW" : "", m.deleted ? "DELETED" : "", m.edited_ts ? "edited" : ""].filter(Boolean);
      const [first, ...rest] = text.split("\n");
      const head = tagList.length ? `${first} · ${tagList.join(" · ")}` : first;
      return [head, `  ↳ ${messageLink(base, m)}`, ...rest].join("\n");
    };
    if (root) out.push(renderRow(root, root.ts > item.ack_ts), "");
    if (skipped > 0) out.push(`  … ${skipped} earlier replies`, "");
    for (const m of shownOld) out.push(renderRow(m, false), "");
    if (fresh.length > shownNew.length + (root && fresh.includes(root) ? 1 : 0)) {
      out.push(`  … ${fresh.length - shownNew.length} more new messages above (open the link)`, "");
    }
    for (const m of shownNew) out.push(renderRow(m, true), "");
  }
  if (!itemList.length) out.push("(nothing pending)");
  return out.join("\n").trimEnd();
};

/** Mark items read in the inbox (never in Slack). `upto` keeps items that arrived after you looked. */
export const ack = async (opts: {
  profile?: string;
  upto?: number;
  keyList: string[];
  tier?: number;
}): Promise<string> => {
  const inbox = await openInbox(opts.profile);
  let changed = 0;
  if (opts.upto !== undefined) {
    changed += inbox.db
      .query("UPDATE item SET ack_seq = seq, ack_ts = last_ts WHERE seq > ack_seq AND seq <= ? AND tier <= ?")
      .run(opts.upto, opts.tier ?? 2).changes;
  }
  for (const key of opts.keyList) {
    const cut = key.indexOf(":");
    changed += inbox.db
      .query("UPDATE item SET ack_seq = seq, ack_ts = last_ts WHERE channel_id = ? AND root_ts = ?")
      .run(key.slice(0, cut), key.slice(cut + 1)).changes;
  }
  return `acknowledged ${changed} items; ${pendingItemList(inbox, 2).length} still pending`;
};

/**
 * One short line that changes only when something new needs a look (or auth
 * broke). Made for change-detecting pollers: acking does not move it.
 */
export const mark = async (profile?: string): Promise<string> => {
  const inbox = await openInbox(profile);
  const auth = getState(inbox.db, "auth") ?? "?";
  return `wake ${getState(inbox.db, "wake_seq") ?? "0"} auth ${auth.startsWith("fail") ? "FAIL" : auth}`;
};

export const tickLine = async (profile: string | undefined, failure: string): Promise<string> => {
  const inbox = await openInbox(profile);
  const line = await mark(profile);
  if (!failure || failure.includes("another inbox run")) {
    if (!failure) {
      setState(inbox.db, "fail_since", "");
      setState(inbox.db, "fail_count", "0");
    }
    return line;
  }
  const count = Number(getState(inbox.db, "fail_count") ?? "0") + 1;
  setState(inbox.db, "fail_count", String(count));
  if (!getState(inbox.db, "fail_since")) setState(inbox.db, "fail_since", String(Date.now() / 1000));
  setState(inbox.db, "fail_last", failure.slice(0, 300));
  return count >= 3 ? `${line} · sync failing since ${formatTs(getState(inbox.db, "fail_since") ?? "0")}` : line;
};

export const stats = async (profile?: string): Promise<string> => {
  const inbox = await openInbox(profile);
  const { db } = inbox;
  const count = (sql: string): number => db.query<{ n: number }, []>(sql).get()?.n ?? 0;
  const report = getState(db, "last_report");
  const lastSync = getState(db, "last_sync");
  const floor = getState(db, "floor_ts");
  return [
    `last sync   ${lastSync ? formatTs(lastSync) : "never"} · auth ${getState(db, "auth") ?? "?"}`,
    `floor       ${floor ? formatTs(String(Number(floor) / 1000)) : "-"} · search cursor ${formatTs(getState(db, "search_ts") ?? "0")}`,
    `messages    ${count("SELECT COUNT(*) AS n FROM message")} (${count("SELECT COUNT(*) AS n FROM message WHERE deleted = 1")} deleted) in ${count("SELECT COUNT(DISTINCT channel_id) AS n FROM message")} channels`,
    `items       ${count("SELECT COUNT(*) AS n FROM item")} total · pending tier1 ${count("SELECT COUNT(*) AS n FROM item WHERE seq > ack_seq AND tier = 1")} · tier2 ${count("SELECT COUNT(*) AS n FROM item WHERE seq > ack_seq AND tier = 2")}`,
    `last run    ${report ?? "-"}`,
    `last api    ${getState(db, "last_api") ?? "-"}`,
  ].join("\n");
};

/** Channel grades with 7-day volume, and channels that look human enough to watch. */
export const channelTable = async (profile?: string): Promise<string> => {
  const inbox = await openInbox(profile);
  const since = ((Date.now() - 7 * 86_400_000) / 1000).toFixed(6);
  const rowList = inbox.db
    .query<ChannelRow & { total: number; human: number; counted: number }, [string, string]>(
      `SELECT c.*, COALESCE(s.total, 0) AS total, COALESCE(s.human, 0) AS human, COALESCE(d.counted, 0) AS counted
       FROM channel c
       LEFT JOIN (SELECT channel_id, COUNT(*) AS total, SUM(1 - bot) AS human FROM message WHERE ts >= ? GROUP BY channel_id) s
         ON s.channel_id = c.id
       LEFT JOIN (SELECT channel_id, SUM(total) AS counted FROM day_count WHERE day >= ? GROUP BY channel_id) d
         ON d.channel_id = c.id
       WHERE c.is_member = 1 OR s.total > 0
       ORDER BY c.grade, human DESC, total DESC`,
    )
    .all(since, new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const out = ["grade   member  7d-msgs  human  counted  channel  suggestion"];
  for (const row of rowList) {
    if (row.kind === "im" && row.total === 0) continue;
    const label = await channelLabel(inbox, row, row.id);
    let suggestion = "";
    if (row.grade === "normal" && row.is_member === 1 && row.human >= 10) suggestion = "watch?";
    if (row.grade === "normal" && row.total >= 30 && row.human / row.total < 0.2) suggestion = "bot?";
    out.push(
      [
        row.grade.padEnd(7),
        (row.is_member ? "yes" : "no").padEnd(7),
        String(row.total).padStart(7),
        String(row.human).padStart(6),
        String(row.counted).padStart(8),
        ` ${label}`,
        suggestion ? ` ${suggestion}` : "",
      ].join(" "),
    );
  }
  await inbox.resolver.save();
  return out.join("\n");
};

/**
 * Everything people said since a time, thread by thread, whether acknowledged
 * or not. Acking means "nothing for you to do", not "leave it out of the
 * summary": progress reports in threads you follow belong in a digest.
 * Covers threads that are items (any tier, acked or not) and every human post
 * in DM and watched channels.
 */
export const digest = async (opts: { profile?: string; sinceMs: number; json: boolean }): Promise<string> => {
  const inbox = await openInbox(opts.profile);
  const { db } = inbox;
  const since = (opts.sinceMs / 1000).toFixed(6);
  const self = getState(db, "self_user") ?? "";
  const base = getState(db, "base_url") ?? "";
  const groupList = db
    .query<{ channel_id: string; thread_ts: string; is_root: number; first_ts: string; n: number }, [string]>(
      `SELECT m.channel_id, m.thread_ts, MAX(m.thread_ts = m.ts AND m.reply_count = 0) AS is_root,
              MIN(m.ts) AS first_ts, COUNT(*) AS n
       FROM message m JOIN channel c ON c.id = m.channel_id
       WHERE m.ts >= ? AND m.bot = 0 AND m.deleted = 0 AND m.user <> ''
         AND (c.grade IN ('dm', 'watch')
              OR EXISTS (SELECT 1 FROM item i WHERE i.channel_id = m.channel_id AND i.root_ts = m.thread_ts))
       GROUP BY m.channel_id, m.thread_ts`,
    )
    .all(since);
  // top-level chatter in a DM or watched channel reads as one block per channel
  const blockMap = new Map<string, { channelId: string; rootTs: string; firstTs: string }>();
  for (const g of groupList) {
    const channel = getChannel(db, g.channel_id);
    const flat =
      g.is_root === 1 &&
      (channel?.grade === "dm" || channel?.grade === "watch") &&
      !db.query("SELECT 1 FROM item WHERE channel_id = ? AND root_ts = ?").get(g.channel_id, g.thread_ts);
    const rootTs = flat ? CHANNEL_ROOT : g.thread_ts;
    const key = `${g.channel_id}:${rootTs}`;
    const old = blockMap.get(key);
    if (!old || g.first_ts < old.firstTs) blockMap.set(key, { channelId: g.channel_id, rootTs, firstTs: g.first_ts });
  }
  const blockList = [...blockMap.values()].sort((a, b) => Number(a.firstTs) - Number(b.firstTs));
  const allMessage: SlackMessage[] = [];
  const rendered: {
    label: string;
    link: string;
    flagList: string[];
    root?: MessageRow;
    earlier: number;
    fresh: MessageRow[];
  }[] = [];
  for (const b of blockList) {
    const channel = getChannel(db, b.channelId);
    const label = await channelLabel(inbox, channel, b.channelId);
    const item = db
      .query<ItemRow, [string, string]>("SELECT * FROM item WHERE channel_id = ? AND root_ts = ?")
      .get(b.channelId, b.rootTs);
    const rowList =
      b.rootTs === CHANNEL_ROOT
        ? db
            .query<MessageRow, [string, string]>(
              "SELECT * FROM message WHERE channel_id = ? AND thread_ts = ts AND reply_count = 0 AND ts >= ? ORDER BY ts",
            )
            .all(b.channelId, since)
        : db
            .query<MessageRow, [string, string]>(
              "SELECT * FROM message WHERE channel_id = ? AND thread_ts = ? ORDER BY ts",
            )
            .all(b.channelId, b.rootTs);
    const root = b.rootTs !== CHANNEL_ROOT ? rowList[0] : undefined;
    const fresh = rowList.filter((m) => m.ts >= since && m !== root);
    const reacted = new Set<string>();
    for (const m of rowList) {
      const body = JSON.parse(m.body) as { reactions?: { name: string; users: string[] }[] };
      for (const r of body.reactions ?? []) if (r.users.includes(self)) reacted.add(r.name);
    }
    const youPosted = rowList.some((m) => m.user === self && m.ts >= since);
    const flagList = [
      item ? `tier ${item.tier} · ${item.reason}` : `${channel?.grade ?? "?"} channel`,
      item?.reactivated ? "old thread revived" : "",
      youPosted ? "you posted" : "",
      reacted.size ? `you reacted :${[...reacted].join(": :")}:` : "",
      item ? (item.ack_seq >= item.seq ? "acked" : "pending") : "not an item",
    ].filter(Boolean);
    const link =
      b.rootTs === CHANNEL_ROOT
        ? permalink(base, b.channelId, fresh[0]?.ts ?? b.firstTs)
        : permalink(base, b.channelId, b.rootTs);
    const earlier = rowList.length - fresh.length - (root ? 1 : 0);
    rendered.push({ label, link, flagList, ...(root ? { root } : {}), earlier, fresh });
    for (const m of [root, ...fresh]) if (m) allMessage.push(JSON.parse(m.body) as SlackMessage);
  }
  if (opts.json) {
    await inbox.resolver.save();
    return JSON.stringify(
      rendered.map((r) => ({
        channel: r.label,
        link: r.link,
        flagList: r.flagList,
        root: r.root ? { ...JSON.parse(r.root.body), permalink: messageLink(base, r.root) } : null,
        earlier: r.earlier,
        newList: r.fresh.map((m) => ({ ...JSON.parse(m.body), permalink: messageLink(base, m) })),
      })),
      null,
      2,
    );
  }
  const users = await inbox.resolver.resolveMany(extractMentions(allMessage));
  await inbox.resolver.save();
  const out = [header(`digest since ${formatTs(since)} · ${rendered.length} threads`), ""];
  let index = 0;
  for (const r of rendered) {
    index++;
    out.push(header(`[${index}] ${r.label} · ${r.flagList.join(" · ")}`));
    out.push(r.link);
    if (r.root) {
      const [first, ...rest] = renderMessage(JSON.parse(r.root.body) as SlackMessage, users).split("\n");
      out.push([first, `  ↳ ${messageLink(base, r.root)}`, ...rest].join("\n"), "");
    }
    if (r.earlier > 0) out.push(`  … ${r.earlier} earlier replies`, "");
    for (const m of r.fresh) {
      const [first, ...rest] = renderMessage(JSON.parse(m.body) as SlackMessage, users).split("\n");
      out.push([`${first} · NEW`, `  ↳ ${messageLink(base, m)}`, ...rest].join("\n"), "");
    }
  }
  if (!rendered.length) out.push("(nothing)");
  return out.join("\n").trimEnd();
};
