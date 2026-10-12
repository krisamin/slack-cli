import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const READ_DIAGNOSTIC_ENV = "SLACK_LOCAL_READ_DIAGNOSTICS_FILE";
const INPUT_MAX = 4096;
const RECEIPT_MAX = 8192;
const SLOT_MAX = 20;

export interface ReadFailure {
  method: string;
  input: unknown;
  elapsed_ms: number;
  worker_pid: number | null;
  exit_code: number | null;
  signal: string | number | null;
  timeout_fired: boolean;
  exception_class: string;
  failure_kind: "worker_exit" | "timeout" | "output_limit" | "invalid_json" | "worker_transport";
  stderr_bytes: number;
  stderr_sha256: string;
  stderr_complete: boolean;
}

const ownedDirectory = (path: string): boolean => {
  const stat = lstatSync(path);
  return (
    stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700
  );
};

const safeInput = (method: string, value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { input_type: Array.isArray(value) ? "array" : typeof value };
  const allowed =
    method === "search"
      ? ["query", "channel_id", "user_id", "since", "until", "limit", "include_bot"]
      : method === "thread"
        ? ["channel_id", "root_ts"]
        : [];
  const source = value as Record<string, unknown>;
  const input: Record<string, unknown> = {};
  for (const name of allowed) {
    if (!Object.hasOwn(source, name)) continue;
    const item = source[name];
    if (typeof item === "string")
      input[name] =
        item.length <= 1024
          ? item
          : { type: "string", length: item.length, sha256: createHash("sha256").update(item).digest("hex") };
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) || item === null)
      input[name] = item;
    else input[name] = { invalid_value_type: Array.isArray(item) ? "array" : typeof item };
  }
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded) > INPUT_MAX)
    return {
      omitted: "diagnostic_input_byte_limit",
      bytes: Buffer.byteLength(encoded),
      sha256: createHash("sha256").update(encoded).digest("hex"),
    };
  return { value: input, unknown_key_count: Object.keys(source).filter((name) => !allowed.includes(name)).length };
};

/** Best-effort, failure-only local evidence. Never prints or changes the tool error. */
export const recordReadFailure = (failure: ReadFailure): void => {
  const configPath = process.env[READ_DIAGNOSTIC_ENV];
  if (!configPath || !["metadata", "freshness", "search", "thread"].includes(failure.method)) return;
  let configFd: number | undefined;
  let directoryFd: number | undefined;
  let receiptFd: number | undefined;
  try {
    // Pin the output directory inode for race-safe exclusive creation on Linux.
    // Other platforms keep the opt-in disabled rather than using a racy pathname.
    if (
      process.platform !== "linux" ||
      !isAbsolute(configPath) ||
      realpathSync(configPath) !== resolve(configPath) ||
      !ownedDirectory(dirname(configPath))
    )
      return;
    configFd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const configStat = fstatSync(configFd);
    if (
      !configStat.isFile() ||
      configStat.uid !== process.getuid?.() ||
      (configStat.mode & 0o777) !== 0o600 ||
      configStat.nlink !== 1 ||
      configStat.size > 4096
    )
      return;
    const option: unknown = JSON.parse(readFileSync(configFd, "utf8"));
    if (!option || typeof option !== "object" || Array.isArray(option)) return;
    const value = option as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "directory,max_receipts" ||
      typeof value.directory !== "string" ||
      !isAbsolute(value.directory) ||
      realpathSync(value.directory) !== resolve(value.directory) ||
      !ownedDirectory(value.directory) ||
      !ownedDirectory(dirname(value.directory))
    )
      return;
    if (
      typeof value.max_receipts !== "number" ||
      !Number.isInteger(value.max_receipts) ||
      value.max_receipts < 1 ||
      value.max_receipts > SLOT_MAX
    )
      return;
    directoryFd = openSync(value.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(directoryFd);
    const linked = lstatSync(value.directory);
    if (
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 ||
      stat.dev !== linked.dev ||
      stat.ino !== linked.ino
    )
      return;
    const receipt = JSON.stringify({
      version: 1,
      recorded_at: new Date().toISOString(),
      method: failure.method,
      input: safeInput(failure.method, failure.input),
      elapsed_ms: failure.elapsed_ms,
      worker_pid: failure.worker_pid,
      exit_code: failure.exit_code,
      signal: failure.signal,
      timeout_fired: failure.timeout_fired,
      failure_kind: failure.failure_kind,
      exception_class: ["Error", "TypeError", "SyntaxError", "RangeError"].includes(failure.exception_class)
        ? failure.exception_class
        : "UnknownError",
      worker_exception_class: null,
      worker_exception_class_available: false,
      stderr_bytes: failure.stderr_bytes,
      stderr_sha256: failure.stderr_sha256,
      stderr_complete: failure.stderr_complete,
      note: "Local worker failure evidence only. Search input is private and may itself be sensitive. No model result, stdout/message body, authentication configuration, environment or raw stderr is collected. Worker3s/query/readonly contracts are unchanged.",
    });
    if (Buffer.byteLength(receipt) + 1 > RECEIPT_MAX) return;
    for (let slot = 1; slot <= value.max_receipts; slot++) {
      const path = `/proc/self/fd/${directoryFd}/read-failure-${String(slot).padStart(2, "0")}.json`;
      try {
        receiptFd = openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const output = fstatSync(receiptFd);
      if (
        !output.isFile() ||
        output.uid !== process.getuid?.() ||
        (output.mode & 0o777) !== 0o600 ||
        output.nlink !== 1
      )
        return;
      writeFileSync(receiptFd, `${receipt}\n`);
      fsyncSync(receiptFd);
      fsyncSync(directoryFd);
      return;
    }
    // Existing (even incomplete) slots are never overwritten or retried.
  } catch {
    // Diagnostics cannot replace the original read failure or reflect paths.
  } finally {
    for (const fd of [receiptFd, directoryFd, configFd])
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
  }
};
