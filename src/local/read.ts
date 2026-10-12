import { fileURLToPath } from "node:url";
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
  // Native SQLite calls are synchronous and Bun exposes no progress handler.
  // Isolate fixed, bound queries in a killable process for a real wall timeout.
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./worker.ts", import.meta.url))], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  child.stdin.write(JSON.stringify({ method, input }));
  child.stdin.end();
  try {
    const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader();
      const chunkList: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 1_000_000) {
          child.kill("SIGKILL");
          throw new Error("Local read output exceeds the byte limit.");
        }
        chunkList.push(next.value);
      }
      return Buffer.concat(chunkList).toString("utf8");
    };
    const [output, error, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    if (code !== 0) throw new Error(error.trim() || "Local cache read timed out or failed.");
    return JSON.parse(output) as ReturnType<LocalStore[M]>;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
};

export const makeLocalReader = (): LocalReader => ({
  metadata: () => readLocal("metadata"),
  freshness: () => readLocal("freshness"),
  search: (input) => readLocal("search", input),
  thread: (input) => readLocal("thread", input),
});
