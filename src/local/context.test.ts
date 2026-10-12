import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeThread, askLocal, MODEL_TOOL_LIST, STATUS_SCHEMA } from "./analysis";
import {
  CONTEXT_SAFETY_TOKEN,
  CONTEXT_TOKEN_MAX,
  CONTEXT_WIRE_MAX,
  countedInputTokens,
  freezeRequest,
  metadataView,
  requestFits,
  searchView,
  serializedBytes,
  uniqueVisibleMessages,
} from "./context";
import type { Transport } from "./model";
import { LocalStore } from "./store";

let directory = "";
let store: LocalStore;
const channel = "CTEST1";
const root = "1790000000.000001";
const text = "Please check <@UTEST1>; reply and followup remain open.";
const replyTs = "1790000001.000001";
const replyText = "I replied; I still owe the promised followup by Friday.";
const config = { baseURL: "http://127.0.0.1:18080/v1", model: "synthetic", timeout_ms: 1000, max_tokens: 1800 };
const answer = () => ({
  reply_needed: true,
  task_open: true,
  current_assignee_user_id: "UTEST1",
  deadline: null,
  evidence: [{ channel_id: channel, ts: root, quote: text }],
  needs_human: false,
  summary: "Request remains open.",
});
const done = () =>
  Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer()) } }] });
const call = (name: string, args: Record<string, unknown>, callId: string) => ({
  id: callId,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const tools = (...calls: ReturnType<typeof call>[]) =>
  Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: calls } }] });
const count = (value = 1000) => Response.json({ input_tokens: value, object: "response.input_tokens" });
const dep = (transport: Transport, countTransport: Transport = async () => count()) => ({
  store,
  config,
  transport,
  countTransport,
  lockDirectory: join(directory, "lock"),
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-context-contract-"));
  const db = new Database(join(directory, "cache.db"), { create: true });
  db.exec(`CREATE TABLE channel(id TEXT,name TEXT,kind TEXT,history_ts TEXT);
    CREATE TABLE message(channel_id TEXT,ts TEXT,thread_ts TEXT,user TEXT,text TEXT,bot INTEGER,deleted INTEGER,edited_ts TEXT,reply_count INTEGER,latest_reply TEXT,seen_at INTEGER);
    CREATE TABLE state(key TEXT,value TEXT);CREATE TABLE thread(channel_id TEXT,root_ts TEXT,fetched_at INTEGER);`);
  db.query("INSERT INTO channel VALUES (?,?,?,?)").run(channel, "synthetic-channel", "public", "1790000000");
  db.query(
    "INSERT INTO state VALUES ('self_user','UTEST1'),('base_url','https://synthetic.slack.com'),('last_sync','1790000002')",
  ).run();
  db.query("INSERT INTO thread VALUES (?,?,1)").run(channel, root);
  for (const [ts, message, user, replies] of [
    [root, text, "UTEST2", 1],
    [replyTs, replyText, "UTEST1", 0],
  ] as const)
    db.query("INSERT INTO message VALUES (?,?,?,?,?,0,0,'',?,'',1)").run(channel, ts, root, user, message, replies);
  db.close();
  store = new LocalStore(join(directory, "cache.db"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("UTF8 frozen body and hash include exact tools final schema thinking and max output fields", () => {
  const body = {
    model: "synthetic",
    messages: [{ role: "user", content: "한국어 ASCII" }],
    tools: MODEL_TOOL_LIST,
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 1800,
  };
  const request = freezeRequest(body, 1800);
  expect(request.body).toBe(JSON.stringify(body));
  expect(request.wire_bytes).toBe(Buffer.byteLength(request.body));
  expect(request.body_sha256).toBe(createHash("sha256").update(request.body).digest("hex"));
  expect(request.wire_bytes).toBeGreaterThan(request.body.length);
  expect(requestFits(request, CONTEXT_TOKEN_MAX - 1800 - CONTEXT_SAFETY_TOKEN)).toBe(true);
  expect(requestFits(request, CONTEXT_TOKEN_MAX - 1800 - CONTEXT_SAFETY_TOKEN + 1)).toBe(false);
  expect(requestFits(freezeRequest({ text: "x".repeat(CONTEXT_WIRE_MAX) }, 1800), 1)).toBe(false);
});

test("strict native count response rejects unsupported missing fractional huge and reflected error fields", () => {
  expect(countedInputTokens({ input_tokens: 0, object: "response.input_tokens" })).toBe(0);
  for (const value of [
    {},
    null,
    { input_tokens: 1 },
    { input_tokens: "1000", object: "response.input_tokens" },
    { input_tokens: -1, object: "response.input_tokens" },
    { input_tokens: 1.5, object: "response.input_tokens" },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, object: "response.input_tokens" },
    { input_tokens: 1, object: "wrong" },
    { input_tokens: 1, object: "response.input_tokens", secret: "synthetic-private" },
  ])
    expect(() => countedInputTokens(value)).toThrow();
});

test("metadata selected scope keeps exact names total cached list freshness and explicit omitted IDs within4096bytes", () => {
  const raw = store.metadata();
  raw.channel_list = Array.from({ length: 100 }, (_, i) => ({
    id: `CTEST${i}`,
    name: `synthetic-channel-${i}`,
    kind: "public",
    history_ts: "1790000000",
  }));
  const before = JSON.stringify(raw);
  const projected = metadataView(raw, new Set(["CTEST1"]));
  expect(serializedBytes(projected.view)).toBeLessThanOrEqual(4096);
  const expectedChannel = raw.channel_list[1];
  if (!expectedChannel) throw new Error("missing synthetic channel");
  expect(projected.view.channel_list).toEqual([expectedChannel]);
  expect(projected.view.channel_available_count).toBe(100);
  expect(projected.omission.omitted_count).toBe(99);
  expect(projected.view.freshness).toEqual(raw.freshness);
  expect(projected.omission.omitted_id_list).toHaveLength(99);
  expect(JSON.stringify(raw)).toBe(before);
});

test("search projection is whole snippet items and preserves raw20k AND flags freshness without query mutation", () => {
  const found = store.search({ query: "check" });
  const first = found.message_list[0];
  if (!first) throw new Error("missing synthetic hit");
  found.message_list = Array.from({ length: 50 }, (_, i) => ({
    ...first,
    ts: `17900000${String(i).padStart(2, "0")}.000001`,
    text: "가".repeat(600),
  }));
  found.scanned_count = 20000;
  found.scan_truncated = true;
  found.hit_limit_reached = true;
  const before = JSON.stringify(found);
  const projected = searchView(found);
  expect(serializedBytes(projected.view)).toBeLessThanOrEqual(8192);
  expect(projected.view.term_list).toEqual(["check"]);
  expect(projected.view.scanned_count).toBe(20000);
  expect(projected.view.scan_truncated).toBe(true);
  expect(projected.view.hit_limit_reached).toBe(true);
  expect(projected.view.projection_incomplete).toBe(true);
  expect(projected.view.message_list.length + projected.omission.omitted_count).toBe(50);
  expect(projected.view.projection_omitted_thread_ref_list).toEqual([{ channel_id: channel, root_ts: root }]);
  for (const message of projected.view.message_list) expect(message.text).toBe("가".repeat(600));
  expect(JSON.stringify(found)).toBe(before);
});

test("identical evidence deduplicates and conflicting edits never overwrite the fetched corpus", () => {
  const messages = store.thread({ channel_id: channel, root_ts: root }).message_list;
  expect(uniqueVisibleMessages([...messages, ...messages])).toHaveLength(2);
  const first = messages[0];
  if (!first) throw new Error("missing synthetic root");
  expect(() => uniqueVisibleMessages([...messages, { ...first, text: "Changed hidden root" }])).toThrow("changed");
});

test("count and generation receive byte-identical frozen final body and the same AbortSignal", async () => {
  const bodies: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const transport: Transport = async (path, init) => {
    bodies.push(String(init.body));
    signals.push(init.signal);
    if (path === "/chat/completions/input_tokens") return count(570);
    expect(path).toBe("/chat/completions");
    return done();
  };
  const result = await analyzeThread(
    { channel_id: channel, root_ts: root },
    { store, config, transport, lockDirectory: join(directory, "lock") },
  );
  expect(result.status).toBe("ok");
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(signals[0]).toBe(signals[1]);
  const payload = JSON.parse(bodies[0] ?? "{}");
  expect(payload.response_format.json_schema.schema).toEqual(STATUS_SCHEMA);
  expect(payload.max_tokens).toBe(1800);
  expect(payload.messages[1].content).toContain(text);
  expect(payload.messages[1].content).toContain(replyText);
  if (result.status === "ok") {
    expect(result.context_budget.count_requests).toBe(1);
    expect(result.context_budget.generation_requests).toBe(1);
    expect(result.context_budget.counted_generation_body_sha256_list).toEqual([
      createHash("sha256")
        .update(bodies[0] ?? "")
        .digest("hex"),
    ]);
  }
});

test("native route unsupported or malformed stops before generation without retry or direct fallback", async () => {
  for (const response of [
    () => new Response("synthetic-private-error", { status: 404 }),
    () => Response.json({ input_tokens: 1.5, object: "response.input_tokens" }),
  ]) {
    const paths: string[] = [];
    await expect(
      analyzeThread(
        { channel_id: channel, root_ts: root },
        dep(
          async () => {
            throw new Error("Generation forbidden");
          },
          async (path) => {
            paths.push(path);
            return response();
          },
        ),
      ),
    ).rejects.toThrow();
    expect(paths).toEqual(["/chat/completions/input_tokens"]);
    expect(existsSync(join(directory, "lock/inference.lock"))).toBe(false);
  }
});

test("required thread evidence exceeding token allowance fails and never truncates target text", async () => {
  let generations = 0;
  let seen = "";
  await expect(
    analyzeThread(
      { channel_id: channel, root_ts: root },
      dep(
        async () => {
          generations++;
          return done();
        },
        async (_, init) => {
          seen = String(init.body);
          return count(14073);
        },
      ),
    ),
  ).rejects.toThrow("required evidence exceeds");
  expect(generations).toBe(0);
  expect(seen).toContain(text);
  expect(seen).toContain(replyText);
  expect(store.thread({ channel_id: channel, root_ts: root }).root.text).toBe(text);
});

test("capacity pressure after real search and thread uses one early canonical final inside6calls", async () => {
  let generation = 0;
  let counter = 0;
  const countBodies: string[] = [];
  const generatedBodies: string[] = [];
  const result = await askLocal(
    { question: "Who still owes the check?" },
    dep(
      async (_, init) => {
        generation++;
        generatedBodies.push(String(init.body));
        if (generation === 1) return tools(call("search", { query: "check" }, "s1"));
        if (generation === 2) return tools(call("thread", { channel_id: channel, root_ts: root }, "t2"));
        return done();
      },
      async (_, init) => {
        counter++;
        countBodies.push(String(init.body));
        return count(counter === 3 ? 15000 : 1000);
      },
    ),
  );
  expect(result.status).toBe("ok");
  expect(generation).toBe(3);
  expect(counter).toBe(4);
  const final = JSON.parse(generatedBodies[2] ?? "{}");
  expect(final.tools).toBeUndefined();
  expect(final.response_format.json_schema.schema).toEqual(STATUS_SCHEMA);
  expect(final.messages[1].content).toContain(text);
  expect(final.messages[1].content).toContain(replyText);
  expect(final.messages[1].content).not.toContain('"tool_calls"');
  expect(countBodies[3]).toBe(generatedBodies[2]);
  expect(generatedBodies[0]).toBe(countBodies[0]);
});

test("last6th generation is reserved final with all threads and no seventh request", async () => {
  let generated = 0;
  let counted = 0;
  const result = await askLocal(
    { question: "check" },
    dep(
      async (_, init) => {
        generated++;
        if (generated === 1) return tools(call("search", { query: "check" }, "c1"));
        if (generated === 2) return tools(call("thread", { channel_id: channel, root_ts: root }, "c2"));
        if (generated < 6) return tools(call("metadata", {}, `c${generated}`));
        const body = JSON.parse(String(init.body));
        expect(body.tools).toBeUndefined();
        expect(body.messages[1].content).toContain(replyText);
        return done();
      },
      async () => {
        counted++;
        return count();
      },
    ),
  );
  expect(result.status).toBe("ok");
  expect(generated).toBe(6);
  expect(counted).toBe(6);
});

test("12readonly tool cap triggers final once rather than more tools or ungrounded status", async () => {
  let generated = 0;
  const result = await askLocal(
    { question: "check" },
    dep(async (_, init) => {
      generated++;
      if (generated === 1)
        return tools(
          call("search", { query: "check" }, "search"),
          call("thread", { channel_id: channel, root_ts: root }, "thread"),
          ...Array.from({ length: 10 }, (_, i) => call("metadata", {}, `m${i}`)),
        );
      expect(JSON.parse(String(init.body)).tools).toBeUndefined();
      return done();
    }),
  );
  expect(result.status).toBe("ok");
  expect(generated).toBe(2);
  if (result.status === "ok") expect(result.tool_trace).toHaveLength(12);
});

test("duplicate thread reads compact only exact revisions and keep full root/reply once in final", async () => {
  let generation = 0;
  let finalBody = "";
  const result = await askLocal(
    { question: "check" },
    dep(async (_, init) => {
      generation++;
      if (generation === 1) return tools(call("search", { query: "check" }, "s"));
      if (generation === 2)
        return tools(
          call("thread", { channel_id: channel, root_ts: root }, "t1"),
          call("thread", { channel_id: channel, root_ts: root }, "t2"),
        );
      if (generation === 3) return done();
      finalBody = String(init.body);
      return done();
    }),
  );
  expect(result.status).toBe("ok");
  const data = JSON.parse(JSON.parse(finalBody).messages[1].content);
  expect(data.thread_list).toHaveLength(1);
  expect(data.thread_list[0].root.text).toBe(text);
  expect(data.thread_list[0].message_list[0].text).toBe(replyText);
});

test("read-only parseSearch5AND rejects unchanged arguments instead of cropping model query", async () => {
  let generation = 0;
  await expect(
    askLocal(
      { question: "check" },
      dep(async () => {
        generation++;
        return tools(call("search", { query: "one two three four five six" }, "s"));
      }),
    ),
  ).rejects.toThrow("at most 5");
  expect(generation).toBe(1);
});

test("missing searched/thread evidence cannot use early final or fabricate successful unknown flags", async () => {
  let generation = 0;
  await expect(
    askLocal(
      { question: "check" },
      dep(async () => {
        generation++;
        return tools(call("metadata", {}, `m${generation}`));
      }),
    ),
  ).rejects.toThrow("iteration budget");
  expect(generation).toBe(5);
});

test("too-large UTF8 required root refuses without even issuing a count or generation request", async () => {
  const original = store.thread.bind(store);
  store.thread = (input) => {
    const result = original(input);
    result.root.text = "가".repeat(17000);
    result.message_list = result.message_list.map((message) =>
      message.ts === root ? { ...message, text: result.root.text } : message,
    );
    return result;
  };
  let requests = 0;
  await expect(
    analyzeThread(
      { channel_id: channel, root_ts: root },
      dep(
        async () => {
          requests++;
          return done();
        },
        async () => {
          requests++;
          return count();
        },
      ),
    ),
  ).rejects.toThrow("required evidence exceeds");
  expect(requests).toBe(0);
});

test("changed thread freshness on repeated read is explicit failure rather than evidence overwrite", async () => {
  const original = store.thread.bind(store);
  let reads = 0;
  store.thread = (input) => {
    const result = original(input);
    reads++;
    if (reads === 2) result.freshness.db_fingerprint = "synthetic-later-cache";
    return result;
  };
  let generated = 0;
  await expect(
    askLocal(
      { question: "check" },
      dep(async () => {
        generated++;
        if (generated === 1) return tools(call("search", { query: "check" }, "s"));
        return tools(
          call("thread", { channel_id: channel, root_ts: root }, "t1"),
          call("thread", { channel_id: channel, root_ts: root }, "t2"),
        );
      }),
    ),
  ).rejects.toThrow("revision or freshness changed");
  expect(reads).toBe(2);
  expect(generated).toBe(2);
});

test("search projection omission remains explicit in result and finalpack with needs_human", async () => {
  const original = store.search.bind(store);
  store.search = (input) => {
    const result = original(input);
    const first = result.message_list[0];
    if (!first) throw new Error("missing synthetic hit");
    result.message_list = Array.from({ length: 50 }, (_, i) => ({
      ...first,
      ts: `17900000${String(i).padStart(2, "0")}.000001`,
      text: "가".repeat(600),
    }));
    return result;
  };
  let generated = 0;
  let final = "";
  const result = await askLocal(
    { question: "check" },
    dep(async (_, init) => {
      generated++;
      if (generated === 1) return tools(call("search", { query: "check" }, "s"));
      if (generated === 2) {
        const body = JSON.parse(String(init.body));
        const projection = JSON.parse(body.messages.at(-1).content).result;
        expect(projection.projection_incomplete).toBe(true);
        return tools(call("thread", { channel_id: channel, root_ts: root }, "t"));
      }
      if (generated === 3) return done();
      final = String(init.body);
      return done();
    }),
  );
  expect(result.status).toBe("ok");
  if (result.status === "ok") {
    expect(result.search_incomplete).toBe(true);
    expect(result.model_context_incomplete).toBe(true);
    expect(result.analysis.needs_human).toBe(true);
    expect(result.model_context_omission_list.some((entry) => entry.tool === "search" && entry.omitted_count > 0)).toBe(
      true,
    );
  }
  expect(final).toContain("projection_omission_list");
  expect(final).toContain(replyText);
});

test("counter timeout aborts same signal reclaims lock and cannot continue to generation", async () => {
  let aborted = false;
  let generations = 0;
  await expect(
    analyzeThread(
      { channel_id: channel, root_ts: root },
      {
        ...dep(
          async () => {
            generations++;
            return done();
          },
          async (_, init) => {
            init.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true },
            );
            return new Promise(() => {});
          },
        ),
        config: { ...config, timeout_ms: 40 },
      },
    ),
  ).rejects.toThrow("timed out");
  expect(aborted).toBe(true);
  expect(generations).toBe(0);
  expect(existsSync(join(directory, "lock/inference.lock"))).toBe(false);
});

test("count reservation strict budget and final output length rejection never trigger an extra final", async () => {
  let generation = 0;
  let counted = 0;
  await expect(
    askLocal(
      { question: "check" },
      dep(
        async () => {
          generation++;
          if (generation === 1) return tools(call("search", { query: "check" }, "s"));
          if (generation === 2) return tools(call("thread", { channel_id: channel, root_ts: root }, "t"));
          return Response.json({
            choices: [{ finish_reason: "length", message: { content: JSON.stringify(answer()) } }],
          });
        },
        async () => {
          counted++;
          return count(counted === 3 ? 15000 : 1000);
        },
      ),
    ),
  ).rejects.toThrow("truncated");
  expect(generation).toBe(3);
  expect(counted).toBe(4);
});

test("a final quote from search-only hidden corpus is not accepted without full thread retrieval", async () => {
  const fabricated = answer();
  fabricated.evidence = [{ channel_id: channel, ts: "1790000999.000001", quote: "Search-only hidden text" }];
  let generated = 0;
  await expect(
    askLocal(
      { question: "check" },
      dep(async () => {
        generated++;
        if (generated === 1) return tools(call("search", { query: "check" }, "s"));
        if (generated === 2) return tools(call("thread", { channel_id: channel, root_ts: root }, "t"));
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(fabricated) } }],
        });
      }),
    ),
  ).rejects.toThrow("does not match");
  expect(generated).toBe(4);
});

test("explicit omitted search root can be read in full and cited only from visible final thread", async () => {
  const original = store.search.bind(store);
  store.search = (input) => {
    const result = original(input);
    const first = result.message_list[0];
    if (!first) throw new Error("missing synthetic hit");
    result.message_list = Array.from({ length: 20 }, (_, i) => ({
      ...first,
      ts: `17900001${String(i).padStart(2, "0")}.000001`,
      text: "가".repeat(600),
    }));
    return result;
  };
  let generation = 0;
  const result = await askLocal(
    { question: "check" },
    dep(async (_, init) => {
      generation++;
      if (generation === 1) return tools(call("search", { query: "check" }, "search"));
      if (generation === 2) {
        const body = JSON.parse(String(init.body));
        const view = JSON.parse(body.messages.at(-1).content).result;
        expect(view.projection_omitted_thread_ref_list).toEqual([{ channel_id: channel, root_ts: root }]);
        return tools(call("thread", view.projection_omitted_thread_ref_list[0], "full"));
      }
      const resultAnswer = answer();
      resultAnswer.evidence = [{ channel_id: channel, ts: replyTs, quote: replyText }];
      resultAnswer.deadline = null;
      if (generation === 4) expect(String(init.body)).toContain(replyText);
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(resultAnswer) } }],
      });
    }),
  );
  expect(result.status).toBe("ok");
  if (result.status === "ok") {
    expect(result.analysis.evidence[0]?.quote).toBe(replyText);
    expect(result.context_budget.raw_search_result_count).toBe(1);
    expect(result.context_budget.required_thread_message_count).toBe(2);
    expect(result.analysis.needs_human).toBe(true);
  }
});

test("no native authorization failure can trigger retry generation or direct raw endpoint bypass", async () => {
  let calls = 0;
  let generations = 0;
  await expect(
    analyzeThread(
      { channel_id: channel, root_ts: root },
      dep(
        async () => {
          generations++;
          return done();
        },
        async () => {
          calls++;
          return new Response("private token path and key", { status: 401 });
        },
      ),
    ),
  ).rejects.toThrow("Local model HTTP 401.");
  expect(calls).toBe(1);
  expect(generations).toBe(0);
});
