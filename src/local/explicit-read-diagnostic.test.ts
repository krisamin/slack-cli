import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let home = "";
let explicit = "";
let fallback = "";
let firstSink = "";
let secondSink = "";
const root = fileURLToPath(new URL(".", import.meta.url));
// Exact source-only tools/list bytes at base00d66; no private data.
const BASE_DEFINITION_SHA = "bd0e0c513bbbb00131b6530a0195eb9a2ae7643d2c8bf2e219cd5cb0f9f24261";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slack-explicit-diag-"));
  chmodSync(home, 0o700);
  firstSink = join(home, "first");
  secondSink = join(home, "second");
  for (const sink of [firstSink, secondSink]) mkdirSync(sink, { mode: 0o700 });
  explicit = join(home, "explicit.json");
  fallback = join(home, "fallback.json");
  writeFileSync(explicit, JSON.stringify({ directory: firstSink, max_receipts: 3 }), { mode: 0o600 });
  writeFileSync(fallback, JSON.stringify({ directory: secondSink, max_receipts: 3 }), { mode: 0o600 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const run = async (
  action: string,
  option: {
    path?: unknown;
    envPath?: string;
    method?: string;
    input?: unknown;
    configOption?: unknown;
    injectedStore?: boolean;
  } = {},
) => {
  const code = `
    import * as fs from "node:fs";
    import { mock } from "bun:test";
    import { createHash } from "node:crypto";
    const real = {...fs};
    const option = JSON.parse(process.env.TEST_OPTION);
    const paths = [process.env.TEST_EXPLICIT, process.env.TEST_FALLBACK, ...(typeof option.path === "string" ? [option.path] : []), ...(typeof option.configOption === "string" ? [option.configOption] : [])];
    const io = [];
    const selectedCall = (name, fn) => (...args) => {
      const p = args[0];
      if (typeof p === "string" && paths.some(path => p === path)) io.push({name});
      return fn(...args);
    };
    mock.module("node:fs", () => ({...real,
      lstatSync:selectedCall("lstatSync",real.lstatSync),realpathSync:selectedCall("realpathSync",real.realpathSync),
      openSync:selectedCall("openSync",real.openSync),readFileSync:selectedCall("readFileSync",real.readFileSync),
    }));
    globalThis.fetch = async () => {throw new Error("Network forbidden in explicit diagnostic tests.");};
    const beforeENV = process.env.SLACK_LOCAL_READ_DIAGNOSTICS_FILE;
    const originalSpawn = Bun.spawn.bind(Bun);
    let spawnCount = 0;
    let workerSourceAbsolute = true;
    let environmentUnmodified = true;
    let noCWDOverride = true;
    const action = process.env.TEST_ACTION;
    const originalError = new TypeError("synthetic original spawn error");
    Bun.spawn = (...args) => {
      spawnCount++;
      workerSourceAbsolute &&= args[0][0] === process.execPath && args[0][1].startsWith("/") && args[0][1].endsWith("/worker.ts");
      environmentUnmodified &&= args[1].env.SLACK_LOCAL_READ_DIAGNOSTICS_FILE === beforeENV;
      noCWDOverride &&= !("cwd" in args[1]);
      if (action === "spawn-error") throw originalError;
      const body = action === "success" ? 'console.log(JSON.stringify({synthetic:true}));'
        : action === "invalid-json" ? 'console.log("synthetic invalid JSON");'
        : 'console.error("synthetic original worker stderr");process.exit(2);';
      return originalSpawn([process.execPath,"--no-env-file","-e",body],args[1]);
    };
    let result;
    try {
      if (action === "model-config") {
        const {readModelConfig} = await import(process.env.TEST_ROOT + "model.ts");
        result = {status:"ok",config:readModelConfig(process.env.TEST_MODEL_CONFIG)};
      } else if (action === "recorder") {
        const {recordReadFailure} = await import(process.env.TEST_ROOT + "read-diagnostic.ts");
        recordReadFailure({method:"search",input:{query:"synthetic explicit query",limit:7},elapsed_ms:3001,
          worker_pid:null,exit_code:137,signal:"SIGKILL",timeout_fired:true,exception_class:"Error",failure_kind:"timeout",
          stderr_bytes:0,stderr_sha256:createHash("sha256").update("").digest("hex"),stderr_complete:true},option.path);
        result={status:"ok"};
      } else if (action === "analysis-twice") {
        const {analyzeThread}=await import(process.env.TEST_ROOT+"analysis.ts");
        const errors=[];
        for (const path of [process.env.TEST_EXPLICIT,process.env.TEST_FALLBACK]) {
          real.writeFileSync(process.env.TEST_MODEL_CONFIG,JSON.stringify({model:"synthetic",read_diagnostic_file:path}),{mode:0o600});
          try {await analyzeThread({channel_id:"CTEST1",root_ts:"1790000000.000001"},{transport:async()=>{throw new Error("Model forbidden");}});}
          catch(error){errors.push(String(error));}
        }
        result={status:"ok",errors};
      } else if (action === "analysis-success") {
        const {analyzeThread}=await import(process.env.TEST_ROOT+"analysis.ts");
        const freshness={fetched_at:"fixed",last_sync:"1790000002",asof:"1790000002",db_fingerprint:"syntheticfixed",schema_version:1,data_version:1,source:"local_cache"};
        const message={channel_id:"CTEST1",ts:"1790000000.000001",thread_ts:"1790000000.000001",user:"UTEST2",text:"Please check <@UTEST1>.",bot:0,deleted:0,edited_ts:"",reply_count:0,latest_reply:"",seen_at:1};
        const store={freshness:async()=>freshness,metadata:async()=>({freshness,self_user:"UTEST1",base_url:"https://synthetic.slack.com",archive_floor_ts:null,channel_list:[{id:"CTEST1",name:"synthetic",kind:"public",history_ts:"1790000002"}],channel_list_truncated:false,scope:"synthetic"}),
          thread:async()=>({freshness,channel_id:"CTEST1",root_ts:message.ts,self_user:"UTEST1",url:null,thread_fetched_at:1,root:message,message_list:[message],omitted_id_list:[],omitted_count:0,omitted_id_list_truncated:false,truncated:false,needs_human:false,cached_message_count:1,expected_reply_count:0,cache_incomplete:false,edit_after_asof:false,historical_reconstruction_supported:false})};
        const status={reply_needed:true,task_open:true,current_assignee_user_id:"UTEST1",deadline:null,evidence:[{channel_id:"CTEST1",ts:message.ts,quote:message.text}],needs_human:false,summary:"Synthetic open request"};
        const wire=[];
        const transport=async(path,init)=>{wire.push(String(init.body));return path.endsWith("/input_tokens")?Response.json({input_tokens:1000,object:"response.input_tokens"}):Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(status)}}]});};
        const outputs=[];
        for (const selected of [undefined,process.env.TEST_EXPLICIT]) outputs.push(await analyzeThread({channel_id:"CTEST1",root_ts:message.ts},{store,transport,config:{baseURL:"http://127.0.0.1:18080/v1",model:"synthetic",timeout_ms:1000,max_tokens:1800,...(selected===undefined?{}:{read_diagnostic_file:selected})}}));
        result={status:"ok",success_results_equal:JSON.stringify(outputs[0])===JSON.stringify(outputs[1]),wire_equal:wire[0]===wire[1]&&wire[0]===wire[2]&&wire[0]===wire[3],option_path_in_wire:wire.some(body=>body.includes(process.env.TEST_EXPLICIT)),human_review:outputs[1].human_review_required};
      } else if (action === "analysis") {
        const {analyzeThread} = await import(process.env.TEST_ROOT + "analysis.ts");
        result={status:"ok",data:await analyzeThread({channel_id:"CTEST1",root_ts:"1790000000.000001"}, {
          ...(option.injectedStore ? {store:{freshness:async()=>{throw originalError;}}} : {}),
          transport:async()=>{throw new Error("Model/API forbidden.");}
        })};
      } else {
        const {readLocal,makeLocalReader}=await import(process.env.TEST_ROOT + "read.ts");
        const method=option.method??"search";
        const input=option.input??{query:"synthetic explicit query",limit:7};
        const value=action === "reader" ? await makeLocalReader(option.path)[method](input) : await readLocal(method,input,option.path);
        result={status:"ok",data:value};
      }
    } catch(error) {result={status:"error",error:String(error),error_class:error instanceof Error?error.name:"Unknown",
      original_error_identity:error===originalError};}
    console.log(JSON.stringify({...result,diagnostic_path_IO:io.length,spawnCount,workerSourceAbsolute,
      environmentUnmodified,noCWDOverride,processENVUnchanged:process.env.SLACK_LOCAL_READ_DIAGNOSTICS_FILE===beforeENV}));
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", code], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TEST_ROOT: root,
      TEST_OPTION: JSON.stringify(option),
      TEST_ACTION: action,
      TEST_EXPLICIT: explicit,
      TEST_FALLBACK: fallback,
      TEST_MODEL_CONFIG: join(home, ".config/slack-cli/model.json"),
      ...(option.envPath === undefined ? {} : { SLACK_LOCAL_READ_DIAGNOSTICS_FILE: option.envPath }),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout);
};
const modelFile = (path: unknown, present = true) => {
  const file = join(home, ".config/slack-cli/model.json");
  mkdirSync(join(home, ".config/slack-cli"), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ model: "synthetic", ...(present ? { read_diagnostic_file: path } : {}) }), {
    mode: 0o600,
  });
  return file;
};
const receipts = (directory: string) => readdirSync(directory).sort();

test("model option accepts absolute nonexistent diagnostic path without opening it or changing existing defaults", async () => {
  const path = join(home, "not-created/private-config.json");
  modelFile(path);
  const r = await run("model-config", { configOption: path });
  expect(r.status).toBe("ok");
  expect(r.diagnostic_path_IO).toBe(0);
  expect(existsSync(path)).toBe(false);
  expect(r.config).toEqual({
    baseURL: "http://127.0.0.1:18080/v1",
    model: "synthetic",
    timeout_ms: 90000,
    max_tokens: 1800,
    read_diagnostic_file: path,
  });
  expect(r.processENVUnchanged).toBe(true);
});

test("model option missing stays off and malformed type length relative or NUL values fail without diagnostic file access", async () => {
  modelFile(undefined, false);
  const off = await run("model-config");
  expect(off.config.read_diagnostic_file).toBeUndefined();
  expect(off.diagnostic_path_IO).toBe(0);
  for (const value of [null, false, 42, [], {}, "", "relative.json", `/${"x".repeat(1024)}`, "/private\0bad"]) {
    modelFile(value);
    const r = await run("model-config", { configOption: value });
    expect(r.status).toBe("error");
    expect(r.diagnostic_path_IO).toBe(0);
    expect(r.error).toContain("read_diagnostic_file");
    expect(r.error).not.toContain(home);
  }
});

test("explicit recorder path wins over ENV and writes exact private allowed input with unchanged600guards", async () => {
  const r = await run("recorder", { path: explicit, envPath: fallback });
  expect(r.status).toBe("ok");
  expect(r.processENVUnchanged).toBe(true);
  expect(receipts(firstSink)).toEqual(["read-failure-01.json"]);
  expect(receipts(secondSink)).toHaveLength(0);
  const file = join(firstSink, "read-failure-01.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const data = JSON.parse(readFileSync(file, "utf8"));
  expect(data.method).toBe("search");
  expect(data.input).toEqual({ value: { query: "synthetic explicit query", limit: 7 }, unknown_key_count: 0 });
  expect(data.timeout_fired).toBe(true);
});

test("absent explicit option keeps existing CLI ENV compatibility but malformed explicit never falls back to ENV", async () => {
  await run("recorder", { envPath: fallback });
  expect(receipts(secondSink)).toHaveLength(1);
  for (const value of [null, false, 42, "", "relative.json"]) {
    const r = await run("recorder", { path: value, envPath: fallback });
    expect(r.processENVUnchanged).toBe(true);
  }
  expect(receipts(secondSink)).toHaveLength(1);
  expect(receipts(firstSink)).toHaveLength(0);
});

test("explicit unsafe or missing file preserves original worker stderr without exposing path input or switching sinks", async () => {
  chmodSync(explicit, 0o644);
  const r = await run("worker-error", { path: explicit, envPath: fallback });
  expect(r.error).toBe("Error: synthetic original worker stderr");
  expect(r.error).not.toContain(home);
  expect(r.processENVUnchanged).toBe(true);
  expect(receipts(firstSink)).toHaveLength(0);
  expect(receipts(secondSink)).toHaveLength(0);
  const missing = await run("worker-error", { path: join(home, "missing.json"), envPath: fallback });
  expect(missing.error).toBe(r.error);
  expect(receipts(secondSink)).toHaveLength(0);
});

test("default off failure and explicit or ENV successful reads perform0diagnostic option accesses", async () => {
  const off = await run("worker-error");
  expect(off.error).toBe("Error: synthetic original worker stderr");
  expect(off.diagnostic_path_IO).toBe(0);
  for (const option of [{ path: explicit }, { envPath: fallback }, { path: explicit, envPath: fallback }]) {
    const r = await run("success", option);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ synthetic: true });
    expect(r.diagnostic_path_IO).toBe(0);
    expect(r.processENVUnchanged).toBe(true);
    expect(r.spawnCount).toBe(1);
    expect(r.workerSourceAbsolute).toBe(true);
    expect(r.environmentUnmodified).toBe(true);
    expect(r.noCWDOverride).toBe(true);
  }
  expect(receipts(firstSink)).toHaveLength(0);
  expect(receipts(secondSink)).toHaveLength(0);
});

test("readLocal explicit failures keep original spawn object and JSON SyntaxError metadata without ENV mutation", async () => {
  const spawn = await run("spawn-error", { path: explicit });
  expect(spawn.error).toBe("TypeError: synthetic original spawn error");
  expect(spawn.original_error_identity).toBe(true);
  expect(spawn.processENVUnchanged).toBe(true);
  const syntax = await run("invalid-json", { path: explicit });
  expect(syntax.error_class).toBe("SyntaxError");
  expect(syntax.processENVUnchanged).toBe(true);
  expect(receipts(firstSink)).toHaveLength(2);
  const data = receipts(firstSink).map((name) => JSON.parse(readFileSync(join(firstSink, name), "utf8")));
  expect(data.map((item) => item.failure_kind)).toEqual(["worker_transport", "invalid_json"]);
});

test("makeLocalReader selects explicit path for every raw method without passing option to the worker ENV", async () => {
  writeFileSync(explicit, JSON.stringify({ directory: firstSink, max_receipts: 4 }), { mode: 0o600 });
  for (const method of ["metadata", "freshness", "search", "thread"]) {
    const input =
      method === "thread"
        ? { channel_id: "CTEST1", root_ts: "1790000000.000001" }
        : method === "search"
          ? { query: "synthetic explicit query" }
          : {};
    const r = await run("reader", { method, input, path: explicit, envPath: fallback });
    expect(r.error).toBe("Error: synthetic original worker stderr");
    expect(r.environmentUnmodified).toBe(true);
    expect(r.processENVUnchanged).toBe(true);
  }
  expect(receipts(firstSink)).toHaveLength(4);
  expect(receipts(secondSink)).toHaveLength(0);
  const methods = receipts(firstSink).map((name) => JSON.parse(readFileSync(join(firstSink, name), "utf8")).method);
  expect(methods).toEqual(["metadata", "freshness", "search", "thread"]);
  const fourth = JSON.parse(readFileSync(join(firstSink, "read-failure-04.json"), "utf8"));
  expect(fourth.input.value).toEqual({ channel_id: "CTEST1", root_ts: "1790000000.000001" });
});

test("analysis loads selected model option before creating default reader without model count or actual cache access", async () => {
  modelFile(explicit);
  const r = await run("analysis", { configOption: explicit, envPath: fallback });
  expect(r.error).toBe("Error: synthetic original worker stderr");
  expect(r.spawnCount).toBe(1);
  expect(r.processENVUnchanged).toBe(true);
  expect(receipts(firstSink)).toHaveLength(1);
  expect(receipts(secondSink)).toHaveLength(0);
  const data = JSON.parse(readFileSync(join(firstSink, "read-failure-01.json"), "utf8"));
  expect(data.method).toBe("freshness");
  expect(data.input).toEqual({ value: {}, unknown_key_count: 0 });
});

test("dependency.store remains authoritative with selected config option and is not wrapped or replaced", async () => {
  modelFile(explicit);
  const r = await run("analysis", { configOption: explicit, injectedStore: true });
  expect(r.original_error_identity).toBe(true);
  expect(r.spawnCount).toBe(0);
  expect(r.diagnostic_path_IO).toBe(0);
  expect(receipts(firstSink)).toHaveLength(0);
});

test("actual stdio tools12 schemas metadata bytes are identical to base00d66 definitions", async () => {
  const current = fileURLToPath(new URL("../index.ts", import.meta.url));
  const list = async (entry: string) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", entry, "mcp"], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    child.stdin.end();
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(error).toBe("");
    return output;
  };
  const currentOutput = await list(current);
  expect(createHash("sha256").update(currentOutput).digest("hex")).toBe(BASE_DEFINITION_SHA);
  expect(JSON.parse(currentOutput).result.tools).toHaveLength(12);
});

test("same resident analysis process rereads model diagnostic selection per call without rebuilding MCP ENV", async () => {
  modelFile(explicit);
  const r = await run("analysis-twice");
  expect(r.status).toBe("ok");
  expect(r.errors).toEqual(["Error: synthetic original worker stderr", "Error: synthetic original worker stderr"]);
  expect(r.spawnCount).toBe(2);
  expect(r.processENVUnchanged).toBe(true);
  expect(receipts(firstSink)).toHaveLength(1);
  expect(receipts(secondSink)).toHaveLength(1);
});

test("optional selection leaves successful advisory output and generation/count wire identical and diagnostic IO0", async () => {
  const r = await run("analysis-success", { configOption: explicit });
  expect(r.status).toBe("ok");
  expect(r.success_results_equal).toBe(true);
  expect(r.wire_equal).toBe(true);
  expect(r.option_path_in_wire).toBe(false);
  expect(r.human_review).toBe(true);
  expect(r.spawnCount).toBe(0);
  expect(r.diagnostic_path_IO).toBe(0);
  expect(r.processENVUnchanged).toBe(true);
  expect(receipts(firstSink)).toHaveLength(0);
});
