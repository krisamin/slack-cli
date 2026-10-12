import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { boolean, integer, keys, record, text } from "./validation";

export const MODEL_CONFIG_PATH = join(homedir(), ".config", "slack-cli", "model.json");
export interface ModelConfig {
  baseURL: string;
  model: string;
  timeout_ms: number;
  max_tokens: number;
}

export const readModelConfig = (path = MODEL_CONFIG_PATH): ModelConfig => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("Model config must be an owned regular file with mode 0600.");
  }
  const input = record(JSON.parse(readFileSync(path, "utf8")));
  keys(input, ["baseURL", "model", "timeout_ms", "max_tokens"]);
  const baseURL = text(input.baseURL ?? "http://127.0.0.1:18080/v1", "baseURL", 200);
  const parsed = new URL(baseURL ?? "");
  // Literal loopback only, with redirects disabled on every request. Private
  // GPU hosts must use an SSH tunnel; no opt-in can send Slack text externally.
  if (
    !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/v1"
  ) {
    throw new Error(
      "Model baseURL must be http://127.0.0.1:<port>/v1 or http://[::1]:<port>/v1. Use a private SSH tunnel.",
    );
  }
  return {
    baseURL: parsed.href.replace(/\/$/, ""),
    model: text(input.model, "model", 100) ?? "",
    timeout_ms: integer(input.timeout_ms, "timeout_ms", 90_000, 120_000),
    max_tokens: integer(input.max_tokens, "max_tokens", 1800, 4096),
  };
};

export type RunMode = "foreground" | "batch";
export const parseMode = (value: unknown): RunMode => {
  if (value === undefined || value === "foreground") return "foreground";
  if (value === "batch") return "batch";
  throw new Error("mode must be foreground or batch.");
};

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export type Transport = (path: string, init: RequestInit) => Promise<Response>;

export const makeTransport =
  (config: ModelConfig): Transport =>
  (path, init) =>
    fetch(`${config.baseURL}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(config.timeout_ms), ...(init.signal ? [init.signal] : [])]),
    });

export const jsonResponse = async (response: Response, timeoutMs = 120_000): Promise<unknown> => {
  if (!response.ok) throw new Error(`Local model HTTP ${response.status}.`);
  if (!response.body) throw new Error("Local model returned an empty response.");
  const reader = response.body.getReader();
  const chunkList: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Local model response stream timed out.")), timeoutMs);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      size += next.value.length;
      if (size > 1_000_000) throw new Error("Local model response exceeds the byte limit.");
      chunkList.push(next.value);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunkList).toString("utf8"));
};

export const batchBusy = async (config: ModelConfig): Promise<boolean> => {
  const origin = new URL(config.baseURL).origin;
  const get = async (path: string): Promise<unknown> =>
    jsonResponse(
      await fetch(`${origin}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      }),
    );
  try {
    const health = record(await get("/health"));
    if (health.status !== "ok") return true;
    const slotList: unknown = await get("/slots");
    if (!Array.isArray(slotList) || !slotList.length) return true;
    return slotList.some((slot: unknown) => {
      const input = record(slot);
      return boolean(input.is_processing, "is_processing", true);
    });
  } catch {
    return true;
  }
};

export const acquireModel = (
  directory = join(homedir(), ".cache", "slack-cli", "local-model"),
): (() => void) | null => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("Local model lock directory must be private and owned by the current user.");
  }
  const path = join(directory, "inference.lock");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new Error("Unsafe inference lock.");
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid < 1) return null;
    try {
      process.kill(pid, 0);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
      return null;
    }
  }
  try {
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  return () => {
    if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
  };
};
