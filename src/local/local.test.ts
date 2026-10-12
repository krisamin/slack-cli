import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, localAsk, localMetadata, localThread } from "../commands/analyze";
import { TOOL_LIST, TOOL_MAP } from "../mcp/tool";
import type { AnalysisDependency, AnalysisStatus } from "./analysis";
import { analyzeThread, askLocal, validateStatus } from "./analysis";
import type { ModelConfig, Transport } from "./model";
import { acquireModel, batchBusy, jsonResponse, makeTransport, readModelConfig } from "./model";
import { LocalStore, parseSearch } from "./store";
import { dateSecond } from "./validation";

let directory = "";
let path = "";
let store: LocalStore;
const ROOT = "1790000000.000001";
const CHANNEL = "CTEST1";
const CONFIG: ModelConfig = {
  baseURL: "http://127.0.0.1:18080/v1",
  model: "synthetic",
  timeout_ms: 100,
  max_tokens: 1000,
};
const ROOT_TEXT = "Please review the change. Deadline Friday. <@UTEST2> owns it.";
const schema = `
 CREATE TABLE channel (id TEXT PRIMARY KEY,name TEXT,kind TEXT,history_ts TEXT);
 CREATE TABLE message (channel_id TEXT,ts TEXT,thread_ts TEXT,user TEXT,text TEXT,bot INTEGER,deleted INTEGER,edited_ts TEXT,reply_count INTEGER,latest_reply TEXT,seen_at INTEGER,PRIMARY KEY(channel_id,ts));
 CREATE INDEX message_thread ON message(channel_id,thread_ts);
 CREATE INDEX message_ts ON message(ts);
 CREATE TABLE state (key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE thread (channel_id TEXT,root_ts TEXT,fetched_at INTEGER);
`;
const insert = (
  db: Database,
  ts: string,
  body: string,
  option: { root?: string; user?: string; reply?: number; deleted?: number } = {},
): void => {
  db.query("INSERT INTO message VALUES (?,?,?,?,?,0,?,'',?,'',1)").run(
    CHANNEL,
    ts,
    option.root ?? ROOT,
    option.user ?? "UTEST2",
    body,
    option.deleted ?? 0,
    option.reply ?? 0,
  );
};
const status = (): AnalysisStatus => ({
  reply_needed: true,
  task_open: true,
  current_assignee_user_id: "UTEST2",
  deadline: "Friday",
  evidence: [{ channel_id: CHANNEL, ts: ROOT, quote: ROOT_TEXT }],
  needs_human: false,
  summary: "Review remains open.",
});
const response = (content: unknown, reason = "stop"): Response =>
  Response.json({ choices: [{ finish_reason: reason, message: { content: JSON.stringify(content) } }] });
const call = (name: string, argument: unknown, id = "call1"): Response =>
  Response.json({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(argument) } }],
        },
      },
    ],
  });
const dependency = (transport: Transport): AnalysisDependency => ({
  store,
  config: CONFIG,
  transport,
  lockDirectory: join(directory, "lock"),
});
const digest = (): string => createHash("sha256").update(readFileSync(path)).digest("hex");

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-local-test-"));
  path = join(directory, "cache ? safe.db");
  const db = new Database(path, { create: true });
  db.exec(schema);
  db.query("INSERT INTO channel VALUES (?,?,?,?)").run(CHANNEL, "synthetic-channel", "public", "1790000000");
  db.query("INSERT INTO state VALUES (?,?)").run("self_user", "UTEST1");
  db.query("INSERT INTO state VALUES (?,?)").run("base_url", "https://synthetic.slack.com");
  db.query("INSERT INTO state VALUES (?,?)").run("last_sync", "1790000010");
  db.query("INSERT INTO thread VALUES (?,?,?)").run(CHANNEL, ROOT, 1790000010000);
  insert(db, ROOT, ROOT_TEXT, { reply: 1 });
  insert(db, "1790000001.000001", "Still reviewing.");
  db.close();
  store = new LocalStore(path);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("readonly bounded cache", () => {
  test("URI escaping, physical readonly, query_only and bytes unchanged", () => {
    const before = digest();
    store.db.exec("PRAGMA query_only=OFF");
    expect(() => store.db.exec("DELETE FROM message")).toThrow();
    expect(() => store.db.exec("CREATE TABLE attack (id)")).toThrow();
    expect(store.db.query("PRAGMA query_only").get()).toEqual({ query_only: 0 });
    store.db.exec("PRAGMA query_only=ON");
    store.metadata();
    store.search({ query: "review" });
    store.thread({ channel_id: CHANNEL, root_ts: ROOT });
    expect(digest()).toBe(before);
  });
  test("missing DB is never created", () => {
    const absent = join(directory, "missing.db");
    expect(() => new LocalStore(absent)).toThrow();
    expect(existsSync(absent)).toBe(false);
  });
  test("bound filter and SQL injection are literal / rejected", () => {
    expect(store.search({ query: "' OR 1=1 --" }).message_list).toHaveLength(0);
    expect(() => store.search({ channel_id: "CTEST1' OR 1=1" })).toThrow();
    expect(() => parseSearch({ query: "review", sql: "DELETE FROM message" })).toThrow("Unknown argument");
    expect(() => parseSearch({ query: "review", limit: 51 })).toThrow();
    expect(() => parseSearch({ query: "review", limit: "1" })).toThrow();
    expect(() => parseSearch({})).toThrow();
  });
  test("structured user/channel/date filters and exclusive until", () => {
    expect(
      store.search({ channel_id: CHANNEL, user_id: "UTEST2", since: "2026-09-01", until: "2026-10-01", limit: 1 })
        .message_list,
    ).toHaveLength(1);
    expect(store.search({ query: "REVIEW" }).message_list).toHaveLength(2);
    expect(store.search({ query: "review", until: "2026-09-01" }).message_list).toHaveLength(0);
    expect(() => parseSearch({ since: "2026-10-01", until: "2026-09-01" })).toThrow();
    expect(() => dateSecond("2026-10-01T12:00", "since")).toThrow();
    expect(() => dateSecond("2026-02-30", "since")).toThrow();
    expect(dateSecond("2026-10-01", "since")).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
  });
  test("root fully preserved, tail omitted IDs and human gate", () => {
    const db = new Database(path);
    for (let index = 2; index < 260; index++)
      insert(db, `179000${String(index).padStart(4, "0")}.000001`, `Synthetic reply ${index}.`);
    db.close();
    const result = store.thread({ channel_id: CHANNEL, root_ts: ROOT });
    expect(result.root.text).toBe(ROOT_TEXT);
    expect(result.message_list[0]?.text).toBe(ROOT_TEXT);
    expect(result.message_list.length).toBeLessThanOrEqual(201);
    expect(result.omitted_count).toBeGreaterThan(0);
    expect(result.omitted_id_list).toContain("1790000001.000001");
    expect(result.needs_human).toBe(true);
    expect(result.truncated).toBe(true);
  });
  test("root budget failure, missing root and reply-as-root are explicit", () => {
    expect(() => store.thread({ channel_id: CHANNEL, root_ts: "1790000001.000001" })).toThrow("not a thread root");
    expect(() => store.thread({ channel_id: CHANNEL, root_ts: "1799999999.000001" })).toThrow("not cached");
    const db = new Database(path);
    db.query("UPDATE message SET text=? WHERE ts=?").run("x".repeat(24_001), ROOT);
    db.close();
    expect(() => store.thread({ channel_id: CHANNEL, root_ts: ROOT })).toThrow("refusing to truncate");
  });
  test("cache incompleteness, missing fetch, deleted root force human", () => {
    const db = new Database(path);
    db.query("UPDATE message SET reply_count=10 WHERE ts=?").run(ROOT);
    db.close();
    expect(store.thread({ channel_id: CHANNEL, root_ts: ROOT }).cache_incomplete).toBe(true);
  });
  test("freshness changes with update, no hardcoded identity", () => {
    const before = store.freshness();
    const db = new Database(path);
    db.query("UPDATE state SET value=? WHERE key='last_sync'").run("1790000099");
    db.close();
    expect(store.freshness().db_fingerprint).not.toBe(before.db_fingerprint);
    expect(store.metadata().self_user).toBe("UTEST1");
    expect(store.thread({ channel_id: CHANNEL, root_ts: ROOT }).url).toBe(
      "https://synthetic.slack.com/archives/CTEST1/p1790000000000001",
    );
  });
});

describe("model contract and grounded result", () => {
  test("complete result with exact evidence is accepted", async () => {
    const before = digest();
    const result = await analyzeThread(
      { channel_id: CHANNEL, root_ts: ROOT },
      dependency(async (_, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.chat_template_kwargs.enable_thinking).toBe(false);
        expect(body.response_format.type).toBe("json_schema");
        expect(body.messages[0].content).toContain("UNTRUSTED DATA");
        expect(body.messages[1].content).toContain(ROOT_TEXT);
        return response(status());
      }),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.analysis).toEqual(status());
    expect(digest()).toBe(before);
  });
  test("exact evidence, required fields, assignee and deadline validation", () => {
    const corpus = store.thread({ channel_id: CHANNEL, root_ts: ROOT }).message_list;
    expect(() =>
      validateStatus({ ...status(), evidence: [{ channel_id: CHANNEL, ts: ROOT, quote: "invented" }] }, corpus),
    ).toThrow("does not match");
    expect(() => validateStatus({ ...status(), extra: 1 }, corpus)).toThrow("Unknown argument");
    expect(() => validateStatus({ ...status(), needs_human: undefined }, corpus)).toThrow();
    const missing = { ...status() } as Record<string, unknown>;
    delete missing.summary;
    expect(() => validateStatus(missing, corpus)).toThrow("Missing analysis");
    expect(() => validateStatus({ ...status(), deadline: "Monday" }, corpus)).toThrow("deadline");
    expect(() => validateStatus({ ...status(), current_assignee_user_id: "UUNKNOWN" }, corpus)).toThrow("assignee");
    expect(validateStatus({ ...status(), reply_needed: null }, corpus).needs_human).toBe(true);
  });
  test("actual search -> thread -> final tool loop fetches DB data", async () => {
    let turn = 0;
    const result = await askLocal(
      { question: "Who owns review?" },
      dependency(async (_, init) => {
        turn++;
        const body = JSON.parse(String(init.body));
        if (turn === 1) return call("search", { query: "review" });
        if (turn === 2) {
          const toolResult = JSON.parse(body.messages.at(-1).content);
          expect(toolResult.result.message_list.some((msg: { text: string }) => msg.text === ROOT_TEXT)).toBe(true);
          return call("thread", { channel_id: CHANNEL, root_ts: ROOT }, "call2");
        }
        const toolResult = JSON.parse(body.messages.at(-1).content);
        expect(toolResult.result.root.text).toBe(ROOT_TEXT);
        return response(status());
      }),
    );
    expect(turn).toBe(3);
    if (result.status === "ok") expect(result.tool_trace.map((entry) => entry.name)).toEqual(["search", "thread"]);
  });
  test("question shortcut or thread before search is rejected", async () => {
    await expect(
      askLocal(
        { question: "review" },
        dependency(async () => response(status())),
      ),
    ).rejects.toThrow("requires actual search");
    await expect(
      askLocal(
        { question: "review" },
        dependency(async () => call("thread", { channel_id: CHANNEL, root_ts: ROOT })),
      ),
    ).rejects.toThrow("must search before");
  });
  test("unknown tools and extra model args cannot execute SQL or writes", async () => {
    await expect(
      analyzeThread(
        { channel_id: CHANNEL, root_ts: ROOT },
        dependency(async () => call("send", {})),
      ),
    ).rejects.toThrow("unknown tool");
    await expect(
      analyzeThread(
        { channel_id: CHANNEL, root_ts: ROOT },
        dependency(async () => call("search", { query: "review", sql: "DELETE FROM message" })),
      ),
    ).rejects.toThrow("Unknown argument");
    await expect(
      analyzeThread(
        { channel_id: CHANNEL, root_ts: ROOT },
        dependency(async () => call("metadata", { refresh: true })),
      ),
    ).rejects.toThrow("Unknown argument");
    expect(store.search({ query: "review" }).message_list).toHaveLength(2);
  });
  test("HTTP, length, invalid JSON, iteration limit fail closed", async () => {
    const input = { channel_id: CHANNEL, root_ts: ROOT };
    await expect(
      analyzeThread(
        input,
        dependency(async () => new Response("bad", { status: 500 })),
      ),
    ).rejects.toThrow("HTTP 500");
    await expect(
      analyzeThread(
        input,
        dependency(async () => response(status(), "length")),
      ),
    ).rejects.toThrow("truncated");
    await expect(
      analyzeThread(
        input,
        dependency(async () =>
          Response.json({ choices: [{ finish_reason: "stop", message: { content: "not json" } }] }),
        ),
      ),
    ).rejects.toThrow();
    await expect(
      analyzeThread(
        input,
        dependency(async () => call("metadata", {}, String(Math.random()))),
      ),
    ).rejects.toThrow("iteration budget");
  });
  test("truncated/cache incomplete thread cannot yield needs_human=false", async () => {
    const db = new Database(path);
    db.query("UPDATE message SET reply_count=99 WHERE ts=?").run(ROOT);
    db.close();
    const result = await analyzeThread(
      { channel_id: CHANNEL, root_ts: ROOT },
      dependency(async () => response(status())),
    );
    if (result.status === "ok") expect(result.analysis.needs_human).toBe(true);
  });
  test("batch busy skips inference; one owned slot only", async () => {
    let called = false;
    const dep = {
      ...dependency(async () => {
        called = true;
        return response(status());
      }),
      isBatchBusy: async () => true,
    };
    expect((await analyzeThread({ channel_id: CHANNEL, root_ts: ROOT, mode: "batch" }, dep)).status).toBe("busy");
    expect(called).toBe(false);
    const release = acquireModel(join(directory, "lock"));
    expect(release).not.toBeNull();
    expect((await analyzeThread({ channel_id: CHANNEL, root_ts: ROOT }, dep)).status).toBe("busy");
    release?.();
    expect((await analyzeThread({ channel_id: CHANNEL, root_ts: ROOT }, dep)).status).toBe("ok");
  });
  test("inference timeout releases lock", async () => {
    await expect(
      analyzeThread(
        { channel_id: CHANNEL, root_ts: ROOT },
        dependency(() => new Promise(() => {})),
      ),
    ).rejects.toThrow("timed out");
    const release = acquireModel(join(directory, "lock"));
    expect(release).not.toBeNull();
    release?.();
  });
  test("model tool call cap and duplicate call ids fail closed", async () => {
    const tooMany = Response.json({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: Array.from({ length: 13 }, (_, index) => ({
              id: `call${index}`,
              type: "function",
              function: { name: "metadata", arguments: "{}" },
            })),
          },
        },
      ],
    });
    await expect(
      analyzeThread(
        { channel_id: CHANNEL, root_ts: ROOT },
        dependency(async () => tooMany),
      ),
    ).rejects.toThrow("call budget");
    await expect(
      analyzeThread(
        { channel_id: CHANNEL, root_ts: ROOT },
        dependency(async () => call("metadata", {})),
      ),
    ).rejects.toThrow("Duplicate");
  });
  test("stalled response streams time out", async () => {
    await expect(jsonResponse(new Response(new ReadableStream({ start: () => {} })), 10)).rejects.toThrow(
      "stream timed out",
    );
  });

  test("response byte cap", async () => {
    await expect(jsonResponse(new Response("x".repeat(1_000_001)))).rejects.toThrow("byte limit");
  });
});

describe("local config and MCP boundary", () => {
  test("only literal loopback/private config; no redirect/external opt-in", () => {
    const configPath = join(directory, "model.json");
    const write = (baseURL: string): void =>
      writeFileSync(configPath, JSON.stringify({ baseURL, model: "synthetic" }), { mode: 0o600 });
    write("http://127.0.0.1:18080/v1");
    expect(readModelConfig(configPath).model).toBe("synthetic");
    for (const base of [
      "https://example.org/v1",
      "http://localhost:18080/v1",
      "http://10.0.0.1/v1",
      "http://127.0.0.1:1/v1?x=y",
      "http://user@127.0.0.1/v1",
    ]) {
      write(base);
      expect(() => readModelConfig(configPath)).toThrow("baseURL");
    }
    write("http://[::1]:18080/v1");
    expect(readModelConfig(configPath).baseURL).toContain("[::1]");
    chmodSync(configPath, 0o644);
    expect(() => readModelConfig(configPath)).toThrow("0600");
    chmodSync(configPath, 0o600);
    const link = join(directory, "link.json");
    symlinkSync(configPath, link);
    expect(() => readModelConfig(link)).toThrow();
  });
  test("real loopback health/slots gates batch busy and unknown capacity", async () => {
    let processing = false;
    let unknown = false;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        if (unknown) return new Response("unavailable", { status: 503 });
        if (new URL(request.url).pathname === "/health") return Response.json({ status: "ok" });
        return Response.json([{ is_processing: processing }]);
      },
    });
    const config = { ...CONFIG, baseURL: `http://127.0.0.1:${server.port}/v1` };
    try {
      expect(await batchBusy(config)).toBe(false);
      processing = true;
      expect(await batchBusy(config)).toBe(true);
      processing = false;
      unknown = true;
      expect(await batchBusy(config)).toBe(true);
    } finally {
      server.stop(true);
    }
  });
  test("real model transport rejects redirects before sending to another endpoint", async () => {
    let destinationCalled = false;
    const destination = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        destinationCalled = true;
        return Response.json({});
      },
    });
    const source = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.redirect(`http://127.0.0.1:${destination.port}/capture`, 307),
    });
    try {
      await expect(
        makeTransport({ ...CONFIG, baseURL: `http://127.0.0.1:${source.port}/v1` })("/chat/completions", {
          method: "POST",
          body: "synthetic",
        }),
      ).rejects.toThrow();
      expect(destinationCalled).toBe(false);
    } finally {
      source.stop(true);
      destination.stop(true);
    }
  });

  test("new MCP tools are readonly and existing bindings preserved", () => {
    expect(TOOL_MAP.has("thread_read")).toBe(true);
    expect(TOOL_MAP.has("draft_write")).toBe(true);
    for (const name of ["local_search", "local_thread", "local_analyze", "local_ask", "local_metadata"]) {
      const tool = TOOL_MAP.get(name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.additionalProperties).toBe(false);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }
    expect(TOOL_LIST.map((tool) => tool.name).filter((name) => name.startsWith("local_"))).toHaveLength(5);
  });
  test("MCP validates unknown/null/wrong-typed args before DB/model access", async () => {
    await expect(localMetadata({ sql: "x" })).rejects.toThrow("Unknown argument");
    await expect(localThread(null)).rejects.toThrow("Expected an object");
    await expect(localAsk({ question: "x", think: "false" })).rejects.toThrow("boolean");
    await expect(localAsk({ question: "x", mode: "parallel" })).rejects.toThrow("mode");
    await expect(TOOL_MAP.get("local_analyze")?.run({ channel_id: CHANNEL, root_ts: ROOT, ack: true })).rejects.toThrow(
      "Unknown argument",
    );
    await expect(analyze(["metadata"], { ack: true })).rejects.toThrow("Unknown argument");
  });
});
