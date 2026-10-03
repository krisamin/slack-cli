import type { ChannelRow, RawMessage } from "./store";

export interface Self {
  userId: string;
  groupMap: Record<string, string>;
  nameRe: RegExp | null;
}

export interface ThreadFact {
  /** you wrote the root or any reply */
  participated: boolean;
  followed: boolean;
  /** the thread is already an inbox item */
  tracked: boolean;
}

export interface Verdict {
  mine: boolean;
  /** 1 = needs you, 2 = worth knowing, 0 = keep quietly */
  tier: number;
  reasonList: string[];
}

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const buildNameRe = (nameList: string[]): RegExp | null => {
  const list = nameList.map((name) => name.trim()).filter(Boolean);
  return list.length ? new RegExp(list.map(escapeRe).join("|"), "i") : null;
};

/**
 * Rule-based relevance, no model. Strong signals (DM, mention, your group,
 * your thread, your name) make tier 1; a watched channel makes tier 2; a bot
 * saying any of it drops a tier, since alerts that tag you are not people asking.
 */
export const classify = (self: Self, msg: RawMessage, channel: ChannelRow, fact: ThreadFact): Verdict => {
  if (msg.user === self.userId) return { mine: true, tier: 0, reasonList: [] };
  const text = msg.text;
  const strong: string[] = [];
  if (channel.kind === "im") strong.push("dm");
  if (channel.kind === "mpim") strong.push("group-dm");
  if (text.includes(`<@${self.userId}`)) strong.push("mention");
  for (const match of text.matchAll(/<!subteam\^([A-Z0-9]+)/g)) {
    const handle = match[1] ? self.groupMap[match[1]] : undefined;
    if (handle) strong.push(`@${handle}`);
  }
  const quiet = channel.grade === "bot" || channel.grade === "mute";
  if (/<!(here|channel|everyone)\b/.test(text) && channel.is_member === 1 && !quiet) strong.push("@here");
  if (self.nameRe?.test(text)) strong.push("name");
  const isReply = msg.threadTs !== msg.ts;
  if (isReply && fact.participated) strong.push("your-thread");
  if (isReply && fact.followed) strong.push("followed");
  if (isReply && fact.tracked && !strong.length) strong.push("thread");

  const reasonList = [...new Set(strong)];
  let tier = reasonList.length ? 1 : 0;
  if (tier === 0 && channel.grade === "watch") {
    reasonList.push("watch");
    tier = 2;
  }
  if (msg.bot && tier === 1) tier = 2;
  // a quiet channel only speaks up when it names you directly
  if (quiet && !reasonList.some((r) => r === "mention" || r === "name" || r.startsWith("@") || r === "your-thread")) {
    return { mine: false, tier: 0, reasonList: [] };
  }
  return { mine: false, tier, reasonList };
};
