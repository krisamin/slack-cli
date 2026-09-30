import { authTest } from "../commands/auth";
import { draftList, draftRemove, draftWrite } from "../commands/draft";
import { file } from "../commands/file";
import { history } from "../commands/history";
import { read } from "../commands/read";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (input: Record<string, unknown>) => Promise<string>;
}

const optionalString = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const requiredString = (input: Record<string, unknown>, key: string): string => {
  const value = optionalString(input, key);
  if (value === undefined) throw new Error(`"${key}" is required.`);
  return value;
};

const flag = (input: Record<string, unknown>, key: string): boolean => {
  return input[key] === true;
};

/** Undefined rather than an empty array, so an omitted list stays omitted. */
const stringList = (input: Record<string, unknown>, key: string): string[] | undefined => {
  const value = input[key];
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length ? list : undefined;
};

const PROFILE_PROPERTY = {
  profile: {
    type: "string",
    description: "Config profile to use. Defaults to the configured default profile.",
  },
};

const URL_PROPERTY = {
  url: {
    type: "string",
    description: "Slack message or thread URL, copied straight from Slack (Copy link).",
  },
};

/**
 * Every tool returns text. Names are kept short because a host may already
 * namespace them by source: ara advertises these as `slack_thread_read` and so on.
 */
export const TOOL_LIST: ToolDefinition[] = [
  {
    name: "thread_read",
    description:
      "Read a Slack thread with all of its replies. Resolves user mentions to real names and lists attachments.",
    inputSchema: {
      type: "object",
      properties: {
        ...URL_PROPERTY,
        json: {
          type: "boolean",
          description: "Return the raw messages JSON instead of rendered text. Use when you need exact ts values.",
        },
        ...PROFILE_PROPERTY,
      },
      required: ["url"],
    },
    run: (input) =>
      read(requiredString(input, "url"), {
        profile: optionalString(input, "profile"),
        json: flag(input, "json"),
      }),
  },
  {
    name: "channel_history",
    description:
      "List every message a channel got between two times, oldest first. Each thread root shows its reply count and a thread link that thread_read accepts; set include_thread to get the replies inline instead.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Any link into the channel: a channel link, a message link, or an app.slack.com/client URL.",
        },
        since: {
          type: "string",
          description: 'Start, in local time: "2026-09-25", "2026-09-25 13:00", or relative like "3d" / "12h" / "2w".',
        },
        until: {
          type: "string",
          description: "End, same formats as since. Omit for now. A bare date includes that whole day.",
        },
        include_thread: {
          type: "boolean",
          description: "Fetch and print every reply under each thread. One extra API call per thread.",
        },
        json: {
          type: "boolean",
          description: "Return raw messages JSON (with permalink, thread_url and replies) instead of text.",
        },
        ...PROFILE_PROPERTY,
      },
      required: ["url", "since"],
    },
    run: (input) =>
      history(requiredString(input, "url"), {
        profile: optionalString(input, "profile"),
        since: requiredString(input, "since"),
        until: optionalString(input, "until"),
        thread: flag(input, "include_thread"),
        json: flag(input, "json"),
      }),
  },
  {
    name: "thread_file",
    description:
      "Download attachments from a Slack thread and report where each file was saved. Downloads everything unless file_id_list narrows it.",
    inputSchema: {
      type: "object",
      properties: {
        ...URL_PROPERTY,
        file_id_list: {
          type: "array",
          items: { type: "string" },
          description:
            "Download only these attachments, by the id thread_read prints next to each file. Slack names are not unique, so the id is the only way to name one screenshot among several.",
        },
        out: {
          type: "string",
          description: "Directory to save into. Defaults to /tmp/slack-files-<thread ts>.",
        },
        ...PROFILE_PROPERTY,
      },
      required: ["url"],
    },
    run: (input) => {
      const fileIdList = stringList(input, "file_id_list");
      return file(requiredString(input, "url"), {
        profile: optionalString(input, "profile"),
        out: optionalString(input, "out"),
        ...(fileIdList ? { fileIdList } : {}),
      });
    },
  },
  {
    name: "draft_write",
    description:
      "Stage a reply as a draft in the Slack compose box. It is never sent: the user reviews it in Slack and sends it themselves.",
    inputSchema: {
      type: "object",
      properties: {
        ...URL_PROPERTY,
        message: {
          type: "string",
          description: "Draft body as plain text. Separate paragraphs with a blank line and let Slack wrap them.",
        },
        broadcast: {
          type: "boolean",
          description: "Also send the reply to the channel when the user sends it.",
        },
        ...PROFILE_PROPERTY,
      },
      required: ["url", "message"],
    },
    run: (input) =>
      draftWrite(requiredString(input, "url"), {
        profile: optionalString(input, "profile"),
        text: requiredString(input, "message"),
        broadcast: flag(input, "broadcast"),
      }),
  },
  {
    name: "draft_list",
    description: "List pending drafts with their target thread and a text preview.",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "boolean", description: "Return the raw drafts JSON instead of rendered text." },
        ...PROFILE_PROPERTY,
      },
    },
    run: (input) =>
      draftList({
        profile: optionalString(input, "profile"),
        json: flag(input, "json"),
      }),
  },
  {
    name: "draft_rm",
    description: "Delete a pending draft by id, as listed by draft_list.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string", description: "Draft id from draft_list." },
        ...PROFILE_PROPERTY,
      },
      required: ["draft_id"],
    },
    run: (input) =>
      draftRemove(requiredString(input, "draft_id"), {
        profile: optionalString(input, "profile"),
      }),
  },
  {
    name: "auth_test",
    description: "Check which Slack workspace and user the stored session belongs to (auth.test).",
    inputSchema: {
      type: "object",
      properties: { ...PROFILE_PROPERTY },
    },
    run: (input) => authTest(optionalString(input, "profile")),
  },
];

export const TOOL_MAP = new Map(TOOL_LIST.map((tool) => [tool.name, tool]));
