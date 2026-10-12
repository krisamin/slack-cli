import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { boolean, integer, keys, record, text } from "./validation";

export const MODEL_CONFIG_PATH = join(homedir(), ".config", "slack-cli", "model.json");
export interface ModelConfig {
  baseURL: string;
  model: string;
  timeout_ms: number;
  max_tokens: number;
  api_key_file?: string;
  /** Failure-only diagnostic option; not opened while loading model settings. */
  read_diagnostic_file?: string;
  admission?: "direct" | "gateway";
}

export const validateEndpoint = (baseURL: string): string => {
  const parsed = new URL(baseURL);
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
  return parsed.href.replace(/\/$/, "");
};

const readApiKeyFile = (path: string): string => {
  let fd: number | undefined;
  try {
    // Open the descriptor without following the final symlink. Validate the
    // descriptor rather than trusting an earlier pathname permission check.
    if (!isAbsolute(path)) throw new Error("relative");
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o077) !== 0
    ) {
      throw new Error("unsafe-directory");
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) {
      throw new Error("unsafe");
    }
    const buffer = Buffer.alloc(4097);
    let size = 0;
    for (;;) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      size += read;
      if (read === 0 || size === buffer.length) break;
    }
    if (size > 4096) throw new Error("oversized");
    const key = buffer
      .subarray(0, size)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    if (!/^[!-~]+$/.test(key)) throw new Error("invalid");
    return key;
  } catch {
    // No path, filesystem error or key content is reflected to a tool caller.
    throw new Error("API key file must be an owned regular file with mode 0600 and a nonempty single-line ASCII key.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const authorizationHeader = (config: ModelConfig): Record<string, string> =>
  config.api_key_file === undefined ? {} : { authorization: `Bearer ${readApiKeyFile(config.api_key_file)}` };

export const readModelConfig = (path = MODEL_CONFIG_PATH): ModelConfig => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("Model config must be an owned regular file with mode 0600.");
  }
  const input = record(JSON.parse(readFileSync(path, "utf8")));
  keys(input, ["baseURL", "model", "timeout_ms", "max_tokens", "api_key_file", "admission", "read_diagnostic_file"]);
  let admission: "direct" | "gateway" | undefined;
  if (Object.hasOwn(input, "admission")) {
    if (input.admission !== "direct" && input.admission !== "gateway")
      throw new Error("admission must be direct or gateway.");
    admission = input.admission;
  }
  let apiKeyFile: string | undefined;
  if (Object.hasOwn(input, "api_key_file")) {
    apiKeyFile = text(input.api_key_file, "api_key_file", 1024);
    if (!apiKeyFile || !isAbsolute(apiKeyFile)) throw new Error("api_key_file must be an absolute file path.");
    readApiKeyFile(apiKeyFile);
  }
  let readDiagnosticFile: string | undefined;
  if (Object.hasOwn(input, "read_diagnostic_file")) {
    readDiagnosticFile = text(input.read_diagnostic_file, "read_diagnostic_file", 1024);
    if (!readDiagnosticFile || !isAbsolute(readDiagnosticFile))
      throw new Error("read_diagnostic_file must be an absolute file path.");
  }
  if (admission === "gateway" && apiKeyFile === undefined) throw new Error("Gateway admission requires api_key_file.");
  const baseURL = text(input.baseURL ?? "http://127.0.0.1:18080/v1", "baseURL", 200);
  return {
    baseURL: validateEndpoint(baseURL ?? ""),
    model: text(input.model, "model", 100) ?? "",
    timeout_ms: integer(input.timeout_ms, "timeout_ms", 90_000, 120_000),
    max_tokens: integer(input.max_tokens, "max_tokens", 1800, 4096),
    ...(apiKeyFile === undefined ? {} : { api_key_file: apiKeyFile }),
    ...(admission === undefined ? {} : { admission }),
    ...(readDiagnosticFile === undefined ? {} : { read_diagnostic_file: readDiagnosticFile }),
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
  async (path, init) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(authorizationHeader(config))) headers.set(name, value);
    return fetch(`${validateEndpoint(config.baseURL)}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(config.timeout_ms), ...(init.signal ? [init.signal] : [])]),
    });
  };

export const jsonResponse = async (
  response: Response,
  timeoutMs = 120_000,
  allowErrorBody = false,
): Promise<unknown> => {
  if (!allowErrorBody && !response.ok) throw new Error(`Local model HTTP ${response.status}.`);
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
  try {
    return JSON.parse(Buffer.concat(chunkList).toString("utf8"));
  } catch {
    throw new Error("Local model returned invalid JSON.");
  }
};

export class GatewayBusyError extends Error {
  constructor() {
    super("Inference gateway is busy; retry later. No automatic retry was made.");
    this.name = "GatewayBusyError";
  }
}

/** Only the native gateway admission envelope is a skip, never upstream503. */
export const modelResponse = async (response: Response, config: ModelConfig, timeoutMs: number): Promise<unknown> => {
  if (config.admission === "gateway" && response.status === 503) {
    let body: unknown;
    try {
      body = await jsonResponse(response, timeoutMs, true);
    } catch {
      throw new Error("Local model HTTP 503.");
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const error = (body as Record<string, unknown>).error;
      if (error && typeof error === "object" && !Array.isArray(error)) {
        const entry = error as Record<string, unknown>;
        if (entry.type === "overloaded_error" && entry.code === "503") throw new GatewayBusyError();
      }
    }
    throw new Error("Local model HTTP 503.");
  }
  return jsonResponse(response, timeoutMs);
};

export const batchBusy = async (config: ModelConfig): Promise<boolean> => {
  const origin = new URL(validateEndpoint(config.baseURL)).origin;
  const get = async (path: string): Promise<unknown> =>
    jsonResponse(
      await fetch(`${origin}${path}`, {
        headers: authorizationHeader(config),
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
