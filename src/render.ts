import type { UserInfo } from "./users";

export interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackAttachment {
  title?: string;
  text?: string;
  fallback?: string;
}

export interface SlackMessage {
  user?: string;
  bot_id?: string;
  username?: string;
  ts: string;
  text?: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
  reply_count?: number;
  /** set on thread roots and replies; equals ts on the root */
  thread_ts?: string;
  latest_reply?: string;
  subtype?: string;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const c = (code: keyof typeof ANSI, text: string): string => {
  return useColor ? `${ANSI[code]}${text}${ANSI.reset}` : text;
};

export const formatTs = (ts: string): string => {
  const date = new Date(parseFloat(ts) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** Replace <@UXXX> mentions, <#CXXX|name> channels, <url|label> links with readable text. */
export const renderText = (text: string, users: Map<string, UserInfo>): string => {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => {
      const info = users.get(id);
      // mention: @handle(Real Name) — skip the parens when they'd repeat the handle
      const label = info
        ? info.realName && info.realName !== info.handle
          ? `@${info.handle}(${info.realName})`
          : `@${info.handle}`
        : `@${id}`;
      return c("yellow", label);
    })
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name: string) => c("cyan", `#${name}`))
    .replace(/<!subteam\^[A-Z0-9]+(?:\|@?([^>]*))?>/g, (_, name: string | undefined) =>
      c("yellow", `@${name || "group"}`),
    )
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, name: string) => c("yellow", `@${name}`))
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => `${label} (${url})`)
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
};

export const extractMentions = (messages: SlackMessage[]): Set<string> => {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (msg.user) ids.add(msg.user);
    for (const match of (msg.text ?? "").matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return ids;
};

export const renderMessage = (msg: SlackMessage, users: Map<string, UserInfo>): string => {
  const lines: string[] = [];

  let author: string;
  if (msg.user) {
    const info = users.get(msg.user);
    if (info) {
      // author: Real Name(@handle) — just the name when they're identical
      const base = info.realName !== info.handle ? `${info.realName}(@${info.handle})` : info.realName;
      author = info.isBot ? `${base} (bot)` : base;
    } else {
      author = msg.user;
    }
  } else if (msg.username) {
    author = `${msg.username} (bot)`;
  } else if (msg.bot_id) {
    author = `${msg.bot_id} (bot)`;
  } else {
    author = "(unknown)";
  }

  lines.push(`${c("bold", `[${author}]`)} ${c("dim", formatTs(msg.ts))}`);

  const text = renderText(msg.text ?? "", users);
  for (const line of text.split("\n")) {
    lines.push(`  ${line}`);
  }

  for (const file of msg.files ?? []) {
    // The id is part of the line because names collide: a thread of screenshots
    // is a stack of "image.png", and without the id there is no way to say which
    // one you mean, or to pass one to `slack file --file-id-list`.
    const meta = [file.mimetype, file.id].filter(Boolean).join(", ");
    lines.push(c("dim", `  └ file: ${file.name ?? "(unnamed)"}${meta ? ` (${meta})` : ""}`));
  }

  for (const att of msg.attachments ?? []) {
    const summary = att.title ?? att.fallback ?? att.text?.slice(0, 80);
    if (summary) lines.push(c("dim", `  └ link: ${summary}`));
  }

  return lines.join("\n");
};

export const header = (text: string): string => {
  return c("green", `━━ ${text} ━━`);
};
