import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { READ_DIAGNOSTIC_ENV, type ReadFailure, recordReadFailure } from "./read-diagnostic";

let home = "";
let config = "";
let receiptDirectory = "";
const readPath = fileURLToPath(new URL("./read.ts", import.meta.url));
const recorderPath = fileURLToPath(new URL("./read-diagnostic.ts", import.meta.url));
const privateQuery = "synthetic private search";
const secret = "synthetic-do-not-reflect-key";
const failure = (): ReadFailure => ({
  method: "search",
  input: { query: privateQuery, limit: 20 },
  elapsed_ms: 3002,
  worker_pid: 1234,
  exit_code: null,
  signal: "SIGKILL",
  timeout_fired: true,
  failure_kind: "timeout",
  exception_class: "Error",
  stderr_bytes: 0,
  stderr_sha256: createHash("sha256").update("").digest("hex"),
  stderr_complete: true,
});
const files = () => readdirSync(receiptDirectory).sort();
const setConfig = (option: Record<string, unknown> = { directory: receiptDirectory, max_receipts: 3 }) => {
  writeFileSync(config, JSON.stringify(option), { mode: 0o600 });
  chmodSync(config, 0o600);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slack-private-read-diag-"));
  chmodSync(home, 0o700);
  config = join(home, "read-diagnostic.json");
  receiptDirectory = join(home, "failure-receipt");
  mkdirSync(receiptDirectory, { mode: 0o700 });
  chmodSync(receiptDirectory, 0o700);
  delete process.env[READ_DIAGNOSTIC_ENV];
});
afterEach(() => {
  delete process.env[READ_DIAGNOSTIC_ENV];
  rmSync(home, { recursive: true, force: true });
});

const probe = async (action: string, option: { diagnostics?: string; input?: unknown; method?: string } = {}) => {
  const source = `
    globalThis.fetch = async () => { throw new Error("Network forbidden in diagnostic tests."); };
    const { readLocal } = await import(process.env.TEST_READ_SOURCE);
    const savedSpawn = Bun.spawn.bind(Bun);
    const action = process.env.TEST_ACTION;
    let childPID;
    if (action !== "real-read") Bun.spawn = (...args) => {
      const childSource = action === "success" ? 'console.log(JSON.stringify({synthetic:true}));'
        : action === "timeout" ? 'await Bun.sleep(10000);'
        : action === "invalid-json" ? 'console.log("synthetic message body synthetic-do-not-reflect-key");'
        : action === "output-limit" ? 'process.stdout.write("x".repeat(1000100));'
        : 'console.error("synthetic private stderr synthetic-do-not-reflect-key");process.exit(2);';
      const child = savedSpawn([process.execPath,"--no-env-file","-e",childSource],args[1]);
      childPID = child.pid;
      return child;
    };
    const started = performance.now();
    let result;
    try { result = {status:"ok",data:await readLocal(process.env.TEST_METHOD,JSON.parse(process.env.TEST_INPUT))}; }
    catch (error) { result={status:"error",error:String(error)}; }
    console.log(JSON.stringify({...result,elapsed_ms:performance.now()-started,child_pid:childPID}));
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TEST_READ_SOURCE: readPath,
      TEST_METHOD: option.method ?? "search",
      TEST_INPUT: JSON.stringify(option.input ?? { query: privateQuery }),
      TEST_ACTION: action,
      ...(option.diagnostics ? { [READ_DIAGNOSTIC_ENV]: option.diagnostics } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(error).toBe("");
  const result = JSON.parse(output);
  if (result.child_pid) expect(existsSync(`/proc/${result.child_pid}`)).toBe(false);
  return result;
};

test("default off and success perform no diagnostic configuration/file access", async () => {
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
  const absent = join(home, "no-config.json");
  const ok = await probe("success", { diagnostics: absent });
  expect(ok.status).toBe("ok");
  const failed = await probe("worker-error");
  expect(failed.error).toBe("Error: Local cache read timed out or failed.");
  expect(files()).toHaveLength(0);
  expect(existsSync(absent)).toBe(false);
});

test("failure receipt carries exact permitted input and bounded stderr metadata only", async () => {
  setConfig();
  const r = await probe("worker-error", {
    diagnostics: config,
    input: { query: privateQuery, channel_id: "CTEST1", limit: 20, api_key: secret },
  });
  expect(r.error).toBe("Error: Local cache read timed out or failed.");
  expect(JSON.stringify(r)).not.toContain(home);
  expect(JSON.stringify(r)).not.toContain(secret);
  expect(JSON.stringify(r)).not.toContain(privateQuery);
  const receipt = join(receiptDirectory, files()[0] ?? "missing");
  expect(statSync(receipt).mode & 0o777).toBe(0o600);
  const body = readFileSync(receipt, "utf8");
  const data = JSON.parse(body);
  expect(data.input).toEqual({ value: { query: privateQuery, channel_id: "CTEST1", limit: 20 }, unknown_key_count: 1 });
  expect(data.exit_code).toBe(2);
  expect(data.timeout_fired).toBe(false);
  expect(data.failure_kind).toBe("worker_exit");
  expect(data.stderr_bytes).toBe(Buffer.byteLength(`synthetic private stderr ${secret}\n`));
  expect(data.stderr_sha256).toBe(createHash("sha256").update(`synthetic private stderr ${secret}\n`).digest("hex"));
  expect(data.stderr_complete).toBe(true);
  expect(data.exception_class).toBe("Error");
  expect(data.worker_exception_class_available).toBe(false);
  expect(body).not.toContain(secret);
  expect(body).not.toContain("synthetic private stderr");
  expect(Buffer.byteLength(body)).toBeLessThan(8192);
});

test("owned600 config and private700 real directories fail closed before any receipt", () => {
  process.env[READ_DIAGNOSTIC_ENV] = config;
  setConfig();
  chmodSync(config, 0o644);
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
  chmodSync(config, 0o600);
  chmodSync(receiptDirectory, 0o755);
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
  chmodSync(receiptDirectory, 0o700);
  const alias = join(home, "linked-config");
  symlinkSync(config, alias);
  process.env[READ_DIAGNOSTIC_ENV] = alias;
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
  const linkedDirectory = join(home, "linked-directory");
  symlinkSync(receiptDirectory, linkedDirectory);
  process.env[READ_DIAGNOSTIC_ENV] = config;
  setConfig({ directory: linkedDirectory, max_receipts: 3 });
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
  const parentLink = join(dirname(home), `${home.split("/").at(-1)}-alias`);
  symlinkSync(home, parentLink);
  try {
    process.env[READ_DIAGNOSTIC_ENV] = join(parentLink, "read-diagnostic.json");
    recordReadFailure(failure());
    expect(files()).toHaveLength(0);
  } finally {
    rmSync(parentLink);
  }
  process.env[READ_DIAGNOSTIC_ENV] = "relative.json";
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
});

test("strict config rejects null unknown keys nonfinite/count bounds and oversized content", () => {
  process.env[READ_DIAGNOSTIC_ENV] = config;
  for (const value of [
    null,
    [],
    {},
    { directory: receiptDirectory, max_receipts: 0 },
    { directory: receiptDirectory, max_receipts: 21 },
    { directory: receiptDirectory, max_receipts: "3" },
    { directory: receiptDirectory, max_receipts: 3, extra: true },
    { directory: "relative", max_receipts: 3 },
  ]) {
    writeFileSync(config, JSON.stringify(value), { mode: 0o600 });
    recordReadFailure(failure());
    expect(files()).toHaveLength(0);
  }
  writeFileSync(config, " ".repeat(4097), { mode: 0o600 });
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
});

test("unknown receipt input properties and huge strings never store keys or unbounded content", () => {
  setConfig();
  process.env[READ_DIAGNOSTIC_ENV] = config;
  recordReadFailure({
    ...failure(),
    input: { query: secret.repeat(500), token: secret, mode: "secret" },
    exception_class: secret,
  });
  const body = readFileSync(join(receiptDirectory, files()[0] ?? "missing"), "utf8");
  expect(body).not.toContain(secret);
  expect(JSON.parse(body).input.value.query.sha256).toBe(createHash("sha256").update(secret.repeat(500)).digest("hex"));
  expect(JSON.parse(body).exception_class).toBe("UnknownError");
  expect(Buffer.byteLength(body)).toBeLessThan(8192);
});

test("exclusive bounded slots never overwrite an existing symlink or partial evidence", () => {
  setConfig({ directory: receiptDirectory, max_receipts: 2 });
  process.env[READ_DIAGNOSTIC_ENV] = config;
  const outside = join(home, "untouched");
  writeFileSync(outside, "do not change", { mode: 0o600 });
  symlinkSync(outside, join(receiptDirectory, "read-failure-01.json"));
  recordReadFailure(failure());
  expect(files()).toEqual(["read-failure-01.json", "read-failure-02.json"]);
  expect(readFileSync(outside, "utf8")).toBe("do not change");
  const prior = readFileSync(join(receiptDirectory, "read-failure-02.json"));
  recordReadFailure(failure());
  expect(readFileSync(join(receiptDirectory, "read-failure-02.json"))).toEqual(prior);
  expect(files()).toHaveLength(2);
});

test("independent writer processes compete for at most three durable failure slots", async () => {
  setConfig({ directory: receiptDirectory, max_receipts: 3 });
  const processes = Array.from({ length: 8 }, () =>
    Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
    const {recordReadFailure}=await import(process.env.TEST_RECORDER_SOURCE);
    recordReadFailure(JSON.parse(process.env.TEST_FAILURE));
  `,
      ],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TEST_RECORDER_SOURCE: recorderPath,
          TEST_FAILURE: JSON.stringify(failure()),
          [READ_DIAGNOSTIC_ENV]: config,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  );
  for (const child of processes) {
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(output).toBe("");
    expect(error).toBe("");
  }
  expect(files()).toHaveLength(3);
  for (const file of files()) {
    expect(JSON.parse(readFileSync(join(receiptDirectory, file), "utf8")).method).toBe("search");
    expect(statSync(join(receiptDirectory, file)).mode & 0o777).toBe(0o600);
  }
});

test("actual worker success with a private synthetic cache leaves diagnostic output empty", async () => {
  const dbPath = join(home, ".local/share/slack-cli/inbox.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  db.exec(
    "CREATE TABLE message(channel_id TEXT,ts TEXT,thread_ts TEXT,text TEXT);CREATE TABLE state(key TEXT,value TEXT);CREATE TABLE channel(id TEXT,name TEXT,kind TEXT,history_ts TEXT)",
  );
  db.close();
  const before = readFileSync(dbPath);
  setConfig();
  const r = await probe("real-read", { diagnostics: config, method: "metadata", input: {} });
  expect(r.status).toBe("ok");
  expect(files()).toHaveLength(0);
  expect(readFileSync(dbPath)).toEqual(before);
});

test("invalid JSON and output overflow store only metadata and return scrubbed errors", async () => {
  setConfig();
  const invalid = await probe("invalid-json", { diagnostics: config });
  expect(invalid.error).toBe("Error: Local cache read returned invalid JSON.");
  const limit = await probe("output-limit", { diagnostics: config });
  expect(limit.error).toBe("Error: Local read output exceeds the byte limit.");
  expect(files()).toHaveLength(2);
  for (const file of files()) {
    const raw = readFileSync(join(receiptDirectory, file), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("synthetic message body");
  }
});

test("a permanently unsafe diagnostic reference never changes the public worker error", async () => {
  const r = await probe("worker-error", { diagnostics: join(home, "missing-config") });
  expect(r.error).toBe("Error: Local cache read timed out or failed.");
  expect(files()).toHaveLength(0);
});

test("timeout records same3s SIGKILL after exact child is reaped without model or DB access", async () => {
  setConfig();
  const r = await probe("timeout", { diagnostics: config });
  expect(r.status).toBe("error");
  expect(r.elapsed_ms).toBeGreaterThanOrEqual(2900);
  expect(r.elapsed_ms).toBeLessThan(4500);
  const data = JSON.parse(readFileSync(join(receiptDirectory, files()[0] ?? "missing"), "utf8"));
  expect(data.timeout_fired).toBe(true);
  expect(data.failure_kind).toBe("timeout");
  expect(data.signal).toBe("SIGKILL");
  expect(data.stderr_bytes).toBe(0);
  expect(data.stderr_complete).toBe(true);
});

test("nonprivate config parent and hardlinked config are rejected without changing evidence", () => {
  setConfig();
  process.env[READ_DIAGNOSTIC_ENV] = config;
  chmodSync(home, 0o755);
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
  chmodSync(home, 0o700);
  const linked = join(home, "hardlinked-config");
  linkSync(config, linked);
  recordReadFailure(failure());
  expect(files()).toHaveLength(0);
});

test("a different effective owner cannot activate the private recorder", async () => {
  setConfig();
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    const originalUID = process.getuid();
    process.getuid = () => originalUID + 1;
    const {recordReadFailure}=await import(process.env.TEST_RECORDER_SOURCE);
    recordReadFailure(JSON.parse(process.env.TEST_FAILURE));
  `,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TEST_RECORDER_SOURCE: recorderPath,
        TEST_FAILURE: JSON.stringify(failure()),
        [READ_DIAGNOSTIC_ENV]: config,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(output).toBe("");
  expect(error).toBe("");
  expect(files()).toHaveLength(0);
});

test("published stdio error never reflects private diagnostic input path or worker stderr", async () => {
  setConfig();
  const serverSource = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));
  const toolSource = fileURLToPath(new URL("../mcp/tool.ts", import.meta.url));
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    globalThis.fetch=async()=>{throw new Error("Network forbidden in MCP diagnostic test.");};
    const originalSpawn=Bun.spawn.bind(Bun);
    Bun.spawn=(...args)=>originalSpawn([process.execPath,"--no-env-file","-e",'console.error("synthetic private stderr synthetic-do-not-reflect-key");process.exit(2);'],args[1]);
    const {runMcp}=await import(process.env.TEST_MCP_SERVER);
    await import(process.env.TEST_MCP_TOOLS);
    runMcp();
  `,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TEST_MCP_SERVER: serverSource,
        TEST_MCP_TOOLS: toolSource,
        [READ_DIAGNOSTIC_ENV]: config,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "local_search", arguments: { query: privateQuery } } })}\n`,
  );
  child.stdin.end();
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(error).toBe("");
  expect(JSON.parse(output).result.isError).toBe(true);
  expect(output).toContain("Local cache read timed out or failed.");
  for (const value of [privateQuery, secret, home, "synthetic private stderr"]) expect(output).not.toContain(value);
  expect(files()).toHaveLength(1);
});
