import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeThread, askLocal, MODEL_TOOL_LIST, STATUS_SCHEMA } from "./analysis";
import { readModelConfig } from "./model";
import { LocalStore } from "./store";

let directory = "";
let store: LocalStore;
const root = "1790000000.000001";
const channel = "CTEST1";
const quote = "Review assigned to <@UTEST2>.";
const key = "synthetic-gateway-key";
const answer = {
  reply_needed: true,
  task_open: true,
  current_assignee_user_id: "UTEST2",
  deadline: null,
  evidence: [{ channel_id: channel, ts: root, quote }],
  needs_human: false,
  summary: "Review remains open.",
};
const completion = () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }] });
const config = (baseURL: string, extra: Record<string, unknown> = {}) => {
  const path = join(directory, "model.json");
  const ref = join(directory, "app-key");
  writeFileSync(ref, key, { mode: 0o600 });
  writeFileSync(
    path,
    JSON.stringify({
      baseURL,
      model: "synthetic",
      timeout_ms: 1000,
      admission: "gateway",
      api_key_file: ref,
      ...extra,
    }),
    { mode: 0o600 },
  );
  return readModelConfig(path);
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-gateway-"));
  const path = join(directory, "cache.db");
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE channel (id TEXT,name TEXT,kind TEXT,history_ts TEXT);
    CREATE TABLE message (channel_id TEXT,ts TEXT,thread_ts TEXT,user TEXT,text TEXT,bot INTEGER,deleted INTEGER,edited_ts TEXT,reply_count INTEGER,latest_reply TEXT,seen_at INTEGER);
    CREATE TABLE state (key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE thread (channel_id TEXT,root_ts TEXT,fetched_at INTEGER);`);
  db.query("INSERT INTO channel VALUES ('CTEST1','synthetic','public','1790000000')").run();
  db.query(
    "INSERT INTO state VALUES ('self_user','UTEST1'),('base_url','https://synthetic.slack.com'),('last_sync','1790000001')",
  ).run();
  db.query("INSERT INTO thread VALUES ('CTEST1',?,1)").run(root);
  db.query("INSERT INTO message VALUES ('CTEST1',?,?,'UTEST2',?,0,0,'',0,'',1)").run(root, root, quote);
  db.close();
  store = new LocalStore(path);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("strict gateway opt-in requires a private key reference; absent admission stays direct", () => {
  const baseURL = "http://127.0.0.1:18080/v1";
  expect(config(baseURL).admission).toBe("gateway");
  expect(config(baseURL, { admission: "direct" }).admission).toBe("direct");
  for (const admission of [null, "", "future", false, 42, [], {}]) {
    expect(() => config(baseURL, { admission })).toThrow("admission");
  }
  const path = join(directory, "direct.json");
  writeFileSync(path, JSON.stringify({ baseURL, model: "synthetic" }), { mode: 0o600 });
  expect(readModelConfig(path).admission).toBeUndefined();
  writeFileSync(path, JSON.stringify({ baseURL, model: "synthetic", admission: "gateway" }), { mode: 0o600 });
  expect(() => readModelConfig(path)).toThrow("api_key_file");
});

test("gateway exact overload is an atomic POST batch skip, not a GET capacity preflight", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      return Response.json(
        { error: { type: "overloaded_error", code: "503", message: "synthetic reflected data" } },
        { status: 503, headers: { "retry-after": "1" } },
      );
    },
  });
  try {
    const result = await analyzeThread(
      { channel_id: channel, root_ts: root, mode: "batch" },
      {
        store,
        config: config(`http://127.0.0.1:${server.port}/v1`),
        lockDirectory: join(directory, "lock"),
        isBatchBusy: async () => {
          throw new Error("Gateway must not read llama status.");
        },
      },
    );
    expect(result.status).toBe("busy");
    expect(result).toMatchObject({ mode: "batch" });
    expect(JSON.stringify(result)).not.toContain("synthetic reflected data");
    expect(seen).toEqual(["POST /v1/chat/completions"]);
    expect(existsSync(join(directory, "lock/inference.lock"))).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("gateway foreground overload is an explicit retry-later error and never retried", async () => {
  let called = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      called++;
      return Response.json({ error: { type: "overloaded_error", code: "503" } }, { status: 503 });
    },
  });
  try {
    await expect(
      analyzeThread(
        { channel_id: channel, root_ts: root },
        { store, config: config(`http://127.0.0.1:${server.port}/v1`), lockDirectory: join(directory, "lock") },
      ),
    ).rejects.toThrow("retry later");
    expect(called).toBe(1);
    expect(existsSync(join(directory, "lock/inference.lock"))).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("upstream503, wrong busy type/code, auth errors and wrong HTTP status never become batch skips", async () => {
  const cases = [
    { http: 503, body: { error: { type: "upstream_error", code: "503" } } },
    { http: 503, body: { error: { type: "overloaded_error", code: 503 } } },
    { http: 503, body: { error: { type: "overloaded_error", code: "other" } } },
    { http: 429, body: { error: { type: "overloaded_error", code: "503" } } },
    { http: 401, body: { error: { type: "overloaded_error", code: "503" } } },
    { http: 403, body: { error: { type: "overloaded_error", code: "503" } } },
    { http: 503, body: "not-json reflected prompt" },
  ];
  for (const item of cases) {
    let called = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        called++;
        return new Response(JSON.stringify(item.body), { status: item.http });
      },
    });
    try {
      await expect(
        analyzeThread(
          { channel_id: channel, root_ts: root, mode: "batch" },
          { store, config: config(`http://127.0.0.1:${server.port}/v1`), lockDirectory: join(directory, "lock") },
        ),
      ).rejects.toThrow(`Local model HTTP ${item.http}`);
      expect(called).toBe(1);
      expect(existsSync(join(directory, "lock/inference.lock"))).toBe(false);
    } finally {
      server.stop(true);
    }
  }
});

test("gateway success preserves schema, thinkingfalse and output payload with POST only", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "synthetic",
        max_tokens: 1800,
        chat_template_kwargs: { enable_thinking: false },
      });
      expect(body.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "slack_local_status", strict: true, schema: STATUS_SCHEMA },
      });
      expect(body.stream).toBeUndefined();
      expect(request.headers.has("x-inference-deadline")).toBe(false);
      return Response.json(completion());
    },
  });
  try {
    const result = await analyzeThread(
      { channel_id: channel, root_ts: root, mode: "batch" },
      { store, config: config(`http://127.0.0.1:${server.port}/v1`), lockDirectory: join(directory, "lock") },
    );
    expect(result).toMatchObject({ status: "ok", human_review_required: true, analysis: answer });
    expect(seen).toEqual(["POST /v1/chat/completions"]);
  } finally {
    server.stop(true);
  }
});

test("direct batch preserves health/slots preflight and does not reinterpret overload as gateway skip", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      seen.push(path);
      if (path === "/health") return Response.json({ status: "ok" });
      if (path === "/slots") return Response.json([{ is_processing: false }]);
      return Response.json({ error: { type: "overloaded_error", code: "503" } }, { status: 503 });
    },
  });
  try {
    await expect(
      analyzeThread(
        { channel_id: channel, root_ts: root, mode: "batch" },
        {
          store,
          config: config(`http://127.0.0.1:${server.port}/v1`, { admission: "direct" }),
          lockDirectory: join(directory, "lock"),
        },
      ),
    ).rejects.toThrow("Local model HTTP 503");
    expect(seen).toEqual(["/health", "/slots", "/v1/chat/completions"]);
  } finally {
    server.stop(true);
  }
});

test("body deadline aborts the same transport signal after headers and releases the lock", async () => {
  let aborted = false;
  let bodyCanceled = false;
  const cfg = { baseURL: "http://127.0.0.1:18080/v1", model: "synthetic", max_tokens: 1800, timeout_ms: 35 };
  await expect(
    analyzeThread(
      { channel_id: channel, root_ts: root },
      {
        store,
        config: cfg,
        lockDirectory: join(directory, "lock"),
        transport: async (_path, init) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"choices":'));
              },
              cancel() {
                bodyCanceled = true;
              },
            }),
          );
        },
      },
    ),
  ).rejects.toThrow("timed out");
  await Bun.sleep(10);
  expect(aborted).toBe(true);
  expect(bodyCanceled).toBe(true);
  expect(existsSync(join(directory, "lock/inference.lock"))).toBe(false);
});

test("gateway connection failure stays an error and clears the local lock", async () => {
  const portSource = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({}) });
  const port = portSource.port;
  portSource.stop(true);
  await expect(
    analyzeThread(
      { channel_id: channel, root_ts: root, mode: "batch" },
      {
        store,
        config: config(`http://127.0.0.1:${port}/v1`),
        lockDirectory: join(directory, "lock"),
      },
    ),
  ).rejects.toThrow();
  expect(existsSync(join(directory, "lock/inference.lock"))).toBe(false);
});

test("delayed headers and a never-ending body share one request deadline and abort", async () => {
  let aborted = false;
  let canceled = false;
  const started = performance.now();
  await expect(
    analyzeThread(
      { channel_id: channel, root_ts: root },
      {
        store,
        config: { baseURL: "http://127.0.0.1:18080/v1", model: "synthetic", timeout_ms: 100, max_tokens: 1800 },
        lockDirectory: join(directory, "lock"),
        transport: async (_path, init) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
          await Bun.sleep(60);
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
              },
              cancel() {
                canceled = true;
              },
            }),
          );
        },
      },
    ),
  ).rejects.toThrow("timed out");
  expect(performance.now() - started).toBeLessThan(150);
  expect(aborted).toBe(true);
  expect(canceled).toBe(true);
});

test("malformed successful response never reflects a private prompt in a tool error", async () => {
  await expect(
    analyzeThread(
      { channel_id: channel, root_ts: root },
      {
        store,
        config: { baseURL: "http://127.0.0.1:18080/v1", model: "synthetic", timeout_ms: 100, max_tokens: 1800 },
        lockDirectory: join(directory, "lock"),
        transport: async () => new Response("synthetic private prompt and key must not be reflected"),
      },
    ),
  ).rejects.toThrow("Local model returned invalid JSON.");
});

test("gateway ask executes unchanged search/thread tools then the final schema with no GET or retries", async () => {
  const bodyList: Record<string, unknown>[] = [];
  const methodList: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      methodList.push(request.method);
      const body = (await request.json()) as Record<string, unknown>;
      bodyList.push(body);
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      if (bodyList.length < 3) {
        const name = bodyList.length === 1 ? "search" : "thread";
        const argument = name === "search" ? { query: "Review" } : { channel_id: channel, root_ts: root };
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: `call${bodyList.length}`,
                    type: "function",
                    function: { name, arguments: JSON.stringify(argument) },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json(completion());
    },
  });
  try {
    const result = await askLocal(
      { question: "Who owns the review?", mode: "batch" },
      {
        store,
        config: config(`http://127.0.0.1:${server.port}/v1`),
        lockDirectory: join(directory, "lock"),
      },
    );
    expect(result).toMatchObject({
      status: "ok",
      human_review_required: true,
      tool_trace: [
        { name: "search", argument: { query: "Review" } },
        { name: "thread", argument: { channel_id: channel, root_ts: root } },
      ],
    });
    expect(methodList).toEqual(["POST", "POST", "POST", "POST"]);
    expect(bodyList[0]?.tools).toEqual(MODEL_TOOL_LIST);
    expect(bodyList[0]?.tool_choice).toBe("required");
    expect(bodyList[0]?.parallel_tool_calls).toBe(false);
    expect(bodyList[3]?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "slack_local_status", strict: true, schema: STATUS_SCHEMA },
    });
    for (const body of bodyList) {
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(body.stream).toBeUndefined();
      expect(body.max_tokens).toBe(1800);
    }
  } finally {
    server.stop(true);
  }
});

test("actual loopback nonstream body is closed on the caller deadline after headers", async () => {
  let canceled = false;
  let called = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      called++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"choices":'));
            closeTimer = setTimeout(() => {
              try {
                controller.close();
              } catch {}
            }, 500);
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  try {
    const cfg = { ...config(`http://127.0.0.1:${server.port}/v1`), timeout_ms: 70 };
    const started = performance.now();
    await expect(
      analyzeThread(
        { channel_id: channel, root_ts: root },
        {
          store,
          config: cfg,
          lockDirectory: join(directory, "lock"),
        },
      ),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(250);
    for (let i = 0; i < 20 && !canceled; i++) await Bun.sleep(10);
    expect(canceled).toBe(true);
    expect(called).toBe(1);
    expect(existsSync(join(directory, "lock/inference.lock"))).toBe(false);
  } finally {
    clearTimeout(closeTimer);
    server.stop(true);
  }
});
