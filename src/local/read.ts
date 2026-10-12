import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type ReadFailure, recordReadFailure } from "./read-diagnostic";
import type { LocalStore, SearchInput } from "./store";

export type ReadMethod = "metadata" | "search" | "thread" | "freshness";
export interface LocalReader {
  metadata: () => Promise<ReturnType<LocalStore["metadata"]>>;
  freshness: () => Promise<ReturnType<LocalStore["freshness"]>>;
  search: (input: SearchInput) => Promise<ReturnType<LocalStore["search"]>>;
  thread: (input: { channel_id: string; root_ts: string }) => Promise<ReturnType<LocalStore["thread"]>>;
}

export const readLocal = async <M extends ReadMethod>(
  method: M,
  input: unknown = {},
): Promise<ReturnType<LocalStore[M]>> => {
  const startedAt = performance.now();
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutFired = false;
  let exitCode: number | null = null;
  let failure: unknown;
  let failureCaptured = false;
  const streamJobs: Promise<string>[] = [];
  let failureKind: ReadFailure["failure_kind"] = "worker_transport";
  const stderrState = { bytes: 0, hash: createHash("sha256"), complete: false };
  try {
    // Native SQLite is synchronous; retain the fixed killable worker3s budget.
    child = Bun.spawn([process.execPath, fileURLToPath(new URL("./worker.ts", import.meta.url))], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const activeChild = child;
    timer = setTimeout(() => {
      timeoutFired = true;
      activeChild.kill("SIGKILL");
    }, 3000);
    activeChild.stdin.write(JSON.stringify({ method, input }));
    activeChild.stdin.end();
    const read = async (stream: ReadableStream<Uint8Array>, stderr = false): Promise<string> => {
      const reader = stream.getReader();
      const chunkList: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            if (stderr) stderrState.complete = true;
            break;
          }
          size += next.value.length;
          if (stderr) {
            stderrState.bytes += next.value.length;
            stderrState.hash.update(next.value);
          }
          if (size > 1_000_000) {
            failureKind = "output_limit";
            activeChild.kill("SIGKILL");
            throw new Error("Local read output exceeds the byte limit.");
          }
          chunkList.push(next.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      return Buffer.concat(chunkList).toString("utf8");
    };
    const outputRead = read(activeChild.stdout);
    const errorRead = read(activeChild.stderr, true);
    streamJobs.push(outputRead, errorRead);
    const [output, , code] = await Promise.all([outputRead, errorRead, activeChild.exited]);
    exitCode = code;
    if (code !== 0) {
      failureKind = timeoutFired ? "timeout" : "worker_exit";
      throw new Error("Local cache read timed out or failed.");
    }
    try {
      return JSON.parse(output) as ReturnType<LocalStore[M]>;
    } catch {
      failureKind = "invalid_json";
      throw new Error("Local cache read returned invalid JSON.");
    }
  } catch (error) {
    failure = error;
    failureCaptured = true;
    if (failureKind === "worker_transport") throw new Error("Local cache read timed out or failed.");
    throw error;
  } finally {
    clearTimeout(timer);
    if (child) {
      child.kill();
      exitCode = await child.exited;
      await Promise.allSettled(streamJobs);
    }
    if (failureCaptured)
      recordReadFailure({
        method,
        input,
        elapsed_ms: performance.now() - startedAt,
        worker_pid: child?.pid ?? null,
        exit_code: exitCode,
        signal: child?.signalCode ?? null,
        timeout_fired: timeoutFired,
        failure_kind: failureKind,
        exception_class: failure instanceof Error ? failure.name : "UnknownThrownValue",
        stderr_bytes: stderrState.bytes,
        stderr_sha256: stderrState.hash.digest("hex"),
        stderr_complete: stderrState.complete,
      });
  }
};

export const makeLocalReader = (): LocalReader => ({
  metadata: () => readLocal("metadata"),
  freshness: () => readLocal("freshness"),
  search: (input) => readLocal("search", input),
  thread: (input) => readLocal("thread", input),
});
