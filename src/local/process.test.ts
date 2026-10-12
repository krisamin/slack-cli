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
  model = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      received++;
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
  const toolList = JSON.parse(result.output).result.tools as { name: string; inputSchema: Record<string, unknown> }[];
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
