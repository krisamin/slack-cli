import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
let home = "";
let model: ReturnType<typeof Bun.serve> | undefined;
let received = 0;
let expectedApiKey: string | undefined;
let gatewayBusyResponse = false;
let authorizationList: (string | null)[] = [];
const root = "1790000000.000001";
const message = "Review assigned to <@UTEST2>.";
const status = {
  reply_needed: true,
  task_open: true,
  current_assignee_user_id: "UTEST2",
  deadline: null,
  evidence: [{ channel_id: "CTEST1", ts: root, quote: message }],
  needs_human: false,
  summary: "Review is open.",
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slack-process-test-"));
  const path = join(home, ".local/share/slack-cli/inbox.db");
  mkdirSync(dirname(path), { recursive: true });
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
  db.query("INSERT INTO message VALUES ('CTEST1',?,?,'UTEST2',?,0,0,'',0,'',1)").run(root, root, message);
  db.close();
  received = 0;
  expectedApiKey = undefined;
  gatewayBusyResponse = false;
  authorizationList = [];
  model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const route = new URL(request.url).pathname;
      if (route !== "/v1/chat/completions" && route !== "/v1/chat/completions/input_tokens")
        return new Response("not found", { status: 404 });
      if (route === "/v1/chat/completions") received++;
      if (route === "/v1/chat/completions") authorizationList.push(request.headers.get("authorization"));
      if (expectedApiKey && request.headers.get("authorization") !== `Bearer ${expectedApiKey}`) {
        if (route === "/v1/chat/completions/input_tokens") received++;
        return new Response(`Denied synthetic-secret-reflection ${expectedApiKey}`, { status: 401 });
      }
      if (gatewayBusyResponse) {
        if (route === "/v1/chat/completions/input_tokens") received++;
        return Response.json(
          { error: { type: "overloaded_error", code: "503", message: "synthetic private prompt must not leak" } },
          { status: 503 },
        );
      }
      if (route === "/v1/chat/completions/input_tokens")
        return Response.json({ input_tokens: 1000, object: "response.input_tokens" });
      const body = (await request.json()) as { messages: { content: string }[] };
      expect(body.messages[1]?.content).toContain(message);
      await Bun.sleep(100);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(status) } }] });
    },
  });
  const configPath = join(home, ".config/slack-cli/model.json");
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    configPath,
    JSON.stringify({ baseURL: `http://127.0.0.1:${model.port}/v1`, model: "synthetic", timeout_ms: 1000 }),
    { mode: 0o600 },
  );
});
afterEach(() => {
  model?.stop(true);
  model = undefined;
  rmSync(home, { recursive: true, force: true });
});

const command = async (
  argumentList: string[],
  input?: string,
): Promise<{ code: number; output: string; error: string }> => {
  const child = Bun.spawn([process.execPath, entry, ...argumentList], {
    env: { ...process.env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input) child.stdin.write(input);
  child.stdin.end();
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output, error };
};

test("CLI search parser keeps --json boolean before positional; process read is readonly", async () => {
  const result = await command(["analyze", "search", "--json", "Review", "--channel", "CTEST1", "--limit", "1"]);
  expect(result.code).toBe(0);
  expect(result.error).toBe("");
  expect(JSON.parse(result.output).message_list[0].text).toBe(message);
  expect(received).toBe(0);
});

test("CLI analysis uses private config and loopback server", async () => {
  const result = await command(["analyze", "thread", "CTEST1", root]);
  expect(result.code).toBe(0);
  expect(result.error).toBe("");
  expect(JSON.parse(result.output).analysis.summary).toBe(status.summary);
  expect(received).toBe(1);
});

test("MCP tools/list preserves existing definitions and lists strict local tools", async () => {
  const result = await command(["mcp"], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  expect(result.code).toBe(0);
  expect(result.error).toBe("");
  const toolList = JSON.parse(result.output).result.tools as {
    name: string;
    inputSchema: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }[];
  expect(toolList.length).toBe(12);
  for (const tool of toolList) {
    if (["local_ask", "local_analyze"].includes(tool.name)) {
      expect(tool._meta).toEqual({ "ax.ara/timeoutMs": 150_000 });
    } else {
      expect(tool._meta).toBeUndefined();
    }
  }
  expect(received).toBe(0);
  expect(toolList.some((tool) => tool.name === "draft_write")).toBe(true);
  expect(toolList.find((tool) => tool.name === "local_ask")?.inputSchema.additionalProperties).toBe(false);
});

test("MCP invalid local args are isError; notifications do not run inference", async () => {
  const result = await command(
    ["mcp"],
    `${[
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "local_analyze", arguments: { channel_id: "CTEST1", root_ts: root } },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "local_metadata", arguments: { refresh: true } } },
    ]
      .map((input) => JSON.stringify(input))
      .join("\n")}\n`,
  );
  const line = result.output.trim().split("\n");
  expect(line).toHaveLength(1);
  expect(JSON.parse(line[0] ?? "{}").result.isError).toBe(true);
  expect(received).toBe(0);
});

test("MCP EOF after a readonly worker request preserves its response", async () => {
  const result = await command(
    ["mcp"],
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "local_thread", arguments: { channel_id: "CTEST1", root_ts: root } } })}\n`,
  );
  expect(result.code).toBe(0);
  const frame = JSON.parse(result.output);
  expect(frame.id).toBe(3);
  expect(JSON.parse(frame.result.content[0].text).root.text).toBe(message);
});

test("MCP explicit null-id is a request, readonly annotations are advertised", async () => {
  const result = await command(["mcp"], `${JSON.stringify({ jsonrpc: "2.0", id: null, method: "tools/list" })}\n`);
  const frame = JSON.parse(result.output);
  expect(frame.id).toBeNull();
  const toolList = frame.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
  expect(toolList.find((tool) => tool.name === "local_thread")?.annotations?.readOnlyHint).toBe(true);
});

test("MCP immediate EOF preserves delayed model response and null args fail", async () => {
  const requestList = [
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "local_analyze", arguments: { channel_id: "CTEST1", root_ts: root } },
    },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "local_metadata", arguments: null } },
  ];
  const result = await command(["mcp"], `${requestList.map((input) => JSON.stringify(input)).join("\n")}\n`);
  const frameList = result.output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(frameList).toHaveLength(2);
  expect(frameList.find((frame) => frame.id === 8).result.isError).toBe(true);
  expect(JSON.parse(frameList.find((frame) => frame.id === 7).result.content[0].text).analysis.summary).toBe(
    status.summary,
  );
});

test("MCP protocol parser errors and old initialize version are preserved", async () => {
  const result = await command(
    ["mcp"],
    `broken\nnull\n${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`,
  );
  const frameList = result.output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(frameList[0].error.code).toBe(-32700);
  expect(frameList[1].error.code).toBe(-32600);
  expect(frameList[2].result.protocolVersion).toBe("2024-11-05");
});

test("raw local MCP reads do not parse model auth configuration or call a model", async () => {
  const configPath = join(home, ".config/slack-cli/model.json");
  writeFileSync(configPath, '{"api_key_file":"unsafe-relative-key"}', { mode: 0o600 });
  const requestList = [
    { name: "local_metadata", arguments: {} },
    { name: "local_search", arguments: { query: "Review" } },
    { name: "local_thread", arguments: { channel_id: "CTEST1", root_ts: root } },
  ];
  for (const [i, request] of requestList.entries()) {
    const result = await command(
      ["mcp"],
      `${JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: request })}\n`,
    );
    expect(result.code).toBe(0);
    expect(result.error).toBe("");
    const answer = JSON.parse(result.output);
    expect(answer.result.isError).not.toBe(true);
    expect(result.output).not.toContain("unsafe-relative-key");
  }
  expect(received).toBe(0);
});

test("CLI and MCP analysis authenticate through the optional reference without disclosing it", async () => {
  const key = "synthetic-process-private-key";
  const keyPath = join(home, ".config/slack-cli/app-key");
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  const configPath = join(home, ".config/slack-cli/model.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      baseURL: `http://127.0.0.1:${model?.port}/v1`,
      model: "synthetic",
      timeout_ms: 1000,
      api_key_file: keyPath,
    }),
    { mode: 0o600 },
  );
  expectedApiKey = key;
  const cli = await command(["analyze", "thread", "CTEST1", root]);
  expect(cli.code).toBe(0);
  expect(cli.error).toBe("");
  expect(JSON.parse(cli.output).human_review_required).toBe(true);
  const mcp = await command(
    ["mcp"],
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "local_analyze", arguments: { channel_id: "CTEST1", root_ts: root } } })}\n`,
  );
  expect(mcp.code).toBe(0);
  expect(JSON.parse(mcp.output).result.isError).not.toBe(true);
  expect(authorizationList).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
  for (const output of [cli.output, cli.error, mcp.output, mcp.error]) {
    expect(output).not.toContain(key);
    expect(output).not.toContain(keyPath);
  }
});

test("MCP wrong-key failure is one request, reflects no secret and never bypasses auth", async () => {
  const keyPath = join(home, ".config/slack-cli/app-key");
  writeFileSync(keyPath, "synthetic-wrong-process-key", { mode: 0o600 });
  writeFileSync(
    join(home, ".config/slack-cli/model.json"),
    JSON.stringify({
      baseURL: `http://127.0.0.1:${model?.port}/v1`,
      model: "synthetic",
      timeout_ms: 1000,
      api_key_file: keyPath,
    }),
    { mode: 0o600 },
  );
  expectedApiKey = "synthetic-correct-process-key";
  const mcp = await command(
    ["mcp"],
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "local_analyze", arguments: { channel_id: "CTEST1", root_ts: root } } })}\n`,
  );
  expect(mcp.code).toBe(0);
  expect(JSON.parse(mcp.output).result.isError).toBe(true);
  expect(mcp.output).toContain("Local model HTTP 401");
  expect(mcp.output).not.toContain(expectedApiKey);
  expect(mcp.output).not.toContain("synthetic-wrong-process-key");
  expect(mcp.output).not.toContain(keyPath);
  expect(received).toBe(1);
});

test("MCP gateway batch overload is busy data while foreground is explicit isError", async () => {
  const keyPath = join(home, ".config/slack-cli/app-key");
  const key = "synthetic-gateway-process-key";
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(
    join(home, ".config/slack-cli/model.json"),
    JSON.stringify({
      baseURL: `http://127.0.0.1:${model?.port}/v1`,
      model: "synthetic",
      timeout_ms: 1000,
      api_key_file: keyPath,
      admission: "gateway",
    }),
    { mode: 0o600 },
  );
  expectedApiKey = key;
  gatewayBusyResponse = true;
  const batch = await command(
    ["mcp"],
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "local_analyze", arguments: { channel_id: "CTEST1", root_ts: root, mode: "batch" } } })}\n`,
  );
  expect(batch.code).toBe(0);
  const batchResult = JSON.parse(batch.output).result;
  expect(batchResult.isError).not.toBe(true);
  expect(JSON.parse(batchResult.content[0].text).status).toBe("busy");
  const foreground = await command(
    ["mcp"],
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "local_analyze", arguments: { channel_id: "CTEST1", root_ts: root } } })}\n`,
  );
  expect(foreground.code).toBe(0);
  expect(JSON.parse(foreground.output).result.isError).toBe(true);
  expect(foreground.output).toContain("retry later");
  expect(received).toBe(2);
  expect(batch.output + foreground.output).not.toContain("synthetic private prompt");
  expect(batch.output + foreground.output).not.toContain(key);
});
