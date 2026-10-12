import { createHash } from "node:crypto";
import type { LocalMessage, LocalStore } from "./store";
import { keys, record } from "./validation";

export const CONTEXT_TOKEN_MAX = 16_384;
export const CONTEXT_SAFETY_TOKEN = 512;
export const CONTEXT_WIRE_MAX = 49_152;
export const METADATA_VIEW_MAX = 4096;
export const SEARCH_VIEW_MAX = 8192;
export const COUNT_REQUEST_MAX = 12;
export const COUNT_TIMEOUT_MS = 8000;

export interface ProjectionOmission {
  tool: "metadata" | "search";
  omitted_count: number;
  omitted_id_list: string[];
  // Search omissions keep root references so the model can request a full thread explicitly.
  omitted_thread_ref_list?: { channel_id: string; root_ts: string }[];
}
export const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

export const metadataView = (raw: ReturnType<LocalStore["metadata"]>, scope: Set<string>) => {
  const shown: typeof raw.channel_list = [];
  const selected = scope.size ? raw.channel_list.filter((channel) => scope.has(channel.id)) : raw.channel_list;
  const result = () => ({
    ...raw,
    channel_list: shown,
    channel_available_count: raw.channel_list.length,
    projection_omitted_count: raw.channel_list.length - shown.length,
    projection_omitted_id_list: raw.channel_list
      .filter((channel) => !shown.some((item) => item.id === channel.id))
      .map((channel) => channel.id),
    projection_scope_id_list: [...scope].sort(),
    projection_scope_unknown: [...scope].filter((key) => !raw.channel_list.some((channel) => channel.id === key)),
  });
  if (serializedBytes(result()) > METADATA_VIEW_MAX)
    throw new Error("Metadata scope cannot fit its model context budget.");
  for (const channel of selected) {
    shown.push(channel);
    if (serializedBytes(result()) > METADATA_VIEW_MAX) shown.pop();
  }
  const view = result();
  return {
    view,
    omission: {
      tool: "metadata" as const,
      omitted_count: view.projection_omitted_count,
      omitted_id_list: view.projection_omitted_id_list,
    },
  };
};

export const searchView = (raw: ReturnType<LocalStore["search"]>) => {
  const entries = raw.message_list.map((message) => ({
    channel_id: message.channel_id,
    ts: message.ts,
    thread_ts: message.thread_ts,
    root_ts: message.root_ts,
    user: message.user,
    text: message.text,
    text_truncated: message.text_truncated,
  }));
  const shown: typeof entries = [];
  const result = () => ({
    ...raw,
    message_list: shown,
    raw_hit_count: entries.length,
    projection_omitted_count: entries.length - shown.length,
    projection_omitted_id_list: entries
      .filter((message) => !shown.some((item) => item.channel_id === message.channel_id && item.ts === message.ts))
      .map((message) => `${message.channel_id}/${message.ts}`),
    projection_incomplete: shown.length < entries.length,
    projection_omitted_thread_ref_list: entries
      .filter((message) => !shown.some((item) => item.channel_id === message.channel_id && item.ts === message.ts))
      .map((message) => ({ channel_id: message.channel_id, root_ts: message.root_ts }))
      .filter(
        (entry, index, list) =>
          list.findIndex((other) => other.channel_id === entry.channel_id && other.root_ts === entry.root_ts) === index,
      ),
  });
  if (serializedBytes(result()) > SEARCH_VIEW_MAX) throw new Error("Search scope cannot fit its model context budget.");
  for (const message of entries) {
    shown.push(message);
    if (serializedBytes(result()) > SEARCH_VIEW_MAX) shown.pop();
  }
  const view = result();
  return {
    view,
    omission: {
      tool: "search" as const,
      omitted_count: view.projection_omitted_count,
      omitted_id_list: view.projection_omitted_id_list,
      omitted_thread_ref_list: view.projection_omitted_thread_ref_list,
    },
  };
};

export const uniqueVisibleMessages = (messages: LocalMessage[]): LocalMessage[] => {
  const map = new Map<string, LocalMessage>();
  for (const message of messages) {
    const key = `${message.channel_id}/${message.ts}`;
    const previous = map.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(message))
      throw new Error("Read evidence changed between requests; context cannot be deduplicated safely.");
    map.set(key, message);
  }
  return [...map.values()];
};

export interface FrozenRequest {
  body: string;
  body_sha256: string;
  wire_bytes: number;
  output_tokens: number;
}
export const freezeRequest = (value: Record<string, unknown>, outputTokens: number): FrozenRequest => {
  const body = JSON.stringify(value);
  return {
    body,
    body_sha256: createHash("sha256").update(body).digest("hex"),
    wire_bytes: Buffer.byteLength(body, "utf8"),
    output_tokens: outputTokens,
  };
};
export const countedInputTokens = (value: unknown): number => {
  const input = record(value);
  keys(input, ["input_tokens", "object"]);
  if (
    input.object !== "response.input_tokens" ||
    typeof input.input_tokens !== "number" ||
    !Number.isSafeInteger(input.input_tokens) ||
    input.input_tokens < 0
  )
    throw new Error("Native input token count is invalid; no generation accepted.");
  return input.input_tokens;
};
export const requestFits = (request: FrozenRequest, inputTokens: number): boolean =>
  request.wire_bytes <= CONTEXT_WIRE_MAX &&
  inputTokens + request.output_tokens + CONTEXT_SAFETY_TOKEN <= CONTEXT_TOKEN_MAX;
