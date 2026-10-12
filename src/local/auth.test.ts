import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "./model";
import { batchBusy, makeTransport, readModelConfig } from "./model";

let directory = "";
const KEY = "synthetic-private-gateway-key";
const configFile = (extra: Record<string, unknown> = {}) => {
  const path = join(directory, "model.json");
  writeFileSync(path, JSON.stringify({ baseURL: "http://127.0.0.1:18080/v1", model: "synthetic", ...extra }), {
    mode: 0o600,
  });
  return path;
};
const keyFile = (text = KEY) => {
  const path = join(directory, "app-key");
  writeFileSync(path, text, { mode: 0o600 });
  return path;
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-model-auth-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("optional owned key-file reference", () => {
  test("omission keeps the existing no-auth configuration and path", () => {
    expect(readModelConfig(configFile())).toEqual({
      baseURL: "http://127.0.0.1:18080/v1",
      model: "synthetic",
      timeout_ms: 90_000,
      max_tokens: 1800,
    });
    expect(readFileSync(configFile(), "utf8")).not.toContain(KEY);
  });
  test("configuration contains only an owned mode600 file reference, never its secret", () => {
    const path = keyFile(`${KEY}\n`);
    const config = readModelConfig(configFile({ api_key_file: path }));
    expect(config).toMatchObject({ api_key_file: path });
    expect(JSON.stringify(config)).not.toContain(KEY);
  });
  test("empty, non-string, null, relative and extra raw key configuration fails closed", () => {
    for (const ref of ["", " ", null, false, 42, [], {}, "relative-key", "~/key", "key\0file"]) {
      expect(() => readModelConfig(configFile({ api_key_file: ref }))).toThrow("api_key_file");
    }
    for (const extra of [{ api_key: KEY }, { apiKey: KEY }, { extra: true }]) {
      expect(() => readModelConfig(configFile(extra))).toThrow("Unknown argument");
    }
    const missing = join(directory, "missing-key");
    expect(() => readModelConfig(configFile({ api_key_file: missing }))).toThrow("API key file");
  });
  test("empty, multiline, control-character and oversized key files fail without printing content", () => {
    for (const value of ["", "\n", "  ", `${KEY}\nextra`, `${KEY}\rattack`, `${KEY}\0attack`, "x".repeat(4097)]) {
      const path = keyFile(value);
      expect(() => readModelConfig(configFile({ api_key_file: path }))).toThrow("API key file");
      try {
        readModelConfig(configFile({ api_key_file: path }));
      } catch (error) {
        expect(String(error)).not.toContain(KEY);
      }
    }
  });
  test("symlink, directory and permissions other than600 fail closed", () => {
    const path = keyFile();
    const link = join(directory, "linked-key");
    symlinkSync(path, link);
    expect(() => readModelConfig(configFile({ api_key_file: link }))).toThrow("API key file");
    const folder = join(directory, "key-folder");
    mkdirSync(folder, { mode: 0o700 });
    expect(() => readModelConfig(configFile({ api_key_file: folder }))).toThrow("API key file");
    for (const mode of [0o400, 0o644, 0o660, 0o700]) {
      chmodSync(path, mode);
      expect(() => readModelConfig(configFile({ api_key_file: path }))).toThrow("API key file");
    }
  });
});

test("real loopback requests carry the key; omitted reference sends no Authorization", async () => {
  const headerList: (string | null)[] = [];
  const payloadList: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      headerList.push(request.headers.get("authorization"));
      payloadList.push(await request.json());
      return Response.json({ choices: [] });
    },
  });
  try {
    const input = { baseURL: `http://127.0.0.1:${server.port}/v1`, model: "synthetic", timeout_ms: 1000 };
    const authenticated = readModelConfig(configFile({ ...input, api_key_file: keyFile() }));
    const payload = { model: "synthetic", messages: [], chat_template_kwargs: { enable_thinking: false } };
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
    await makeTransport(authenticated)("/chat/completions", init);
    await makeTransport(readModelConfig(configFile(input)))("/chat/completions", init);
    expect(headerList).toEqual([`Bearer ${KEY}`, null]);
    expect(payloadList).toEqual([payload, payload]);
  } finally {
    server.stop(true);
  }
});

test("rotation is read per request and an unsafe key is rejected before HTTP, with no retry", async () => {
  let called = 0;
  const headerList: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      called++;
      headerList.push(request.headers.get("authorization"));
      return Response.json({});
    },
  });
  try {
    const path = keyFile();
    const config = readModelConfig(configFile({ baseURL: `http://127.0.0.1:${server.port}/v1`, api_key_file: path }));
    const transport = makeTransport(config);
    await transport("/chat/completions", { method: "POST", body: "{}" });
    writeFileSync(path, "synthetic-rotated-key\n");
    await transport("/chat/completions", { method: "POST", body: "{}" });
    expect(headerList).toEqual([`Bearer ${KEY}`, "Bearer synthetic-rotated-key"]);
    chmodSync(path, 0o644);
    await expect(transport("/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow("API key file");
    expect(called).toBe(2);
  } finally {
    server.stop(true);
  }
});

test("legacy private health/slots requests authenticate without claiming atomic admission", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      seen.push(new URL(request.url).pathname);
      if (request.headers.get("authorization") !== `Bearer ${KEY}`) return new Response("denied", { status: 401 });
      return new URL(request.url).pathname === "/health"
        ? Response.json({ status: "ok" })
        : Response.json([{ is_processing: false }]);
    },
  });
  try {
    const config = readModelConfig(
      configFile({ baseURL: `http://127.0.0.1:${server.port}/v1`, api_key_file: keyFile() }),
    );
    expect(await batchBusy(config)).toBe(false);
    expect(seen).toEqual(["/health", "/slots"]);
    writeFileSync(config.api_key_file ?? "", "wrong-synthetic-key");
    expect(await batchBusy(config)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("authenticated redirect never forwards the secret to another endpoint", async () => {
  let destinationCalled = 0;
  const destination = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      destinationCalled++;
      return Response.json({});
    },
  });
  const source = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.redirect(`http://127.0.0.1:${destination.port}/capture`, 307),
  });
  try {
    const config: ModelConfig = readModelConfig(
      configFile({ baseURL: `http://127.0.0.1:${source.port}/v1`, api_key_file: keyFile() }),
    );
    await expect(makeTransport(config)("/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(destinationCalled).toBe(0);
  } finally {
    source.stop(true);
    destination.stop(true);
  }
});

test("wrong ownership is rejected without reflecting the file path or key", async () => {
  const path = keyFile();
  const file = configFile({ api_key_file: path });
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    const { readModelConfig } = await import(process.env.TEST_MODEL_MODULE);
    const realUid = process.getuid();
    let call = 0;
    process.getuid = () => (++call === 1 ? realUid : realUid + 1);
    try { readModelConfig(process.env.TEST_CONFIG_FILE); process.exit(2); }
    catch (error) { console.log(String(error)); }
  `,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        TEST_MODEL_MODULE: join(import.meta.dir, "model.ts"),
        TEST_CONFIG_FILE: file,
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
  expect(error).toBe("");
  expect(output).toContain("API key file");
  expect(output).not.toContain(KEY);
  expect(output).not.toContain(path);
});

test("missing or wrong key is not an accepted completion and is never retried", async () => {
  let called = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      called++;
      return request.headers.get("authorization") === `Bearer ${KEY}`
        ? Response.json({ choices: [] })
        : new Response(`Denied ${KEY}`, { status: 401 });
    },
  });
  try {
    const base = { baseURL: `http://127.0.0.1:${server.port}/v1`, model: "synthetic", timeout_ms: 1000 };
    const noAuth = readModelConfig(configFile(base));
    const wrong = readModelConfig(configFile({ ...base, api_key_file: keyFile("synthetic-wrong-key") }));
    for (const config of [noAuth, wrong]) {
      const response = await makeTransport(config)("/chat/completions", { method: "POST", body: "{}" });
      expect(response.status).toBe(401);
      expect(response.ok).toBe(false);
    }
    expect(called).toBe(2);
  } finally {
    server.stop(true);
  }
});

test("key headers never remove caller cancellation", async () => {
  let called = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      called++;
      return Response.json({});
    },
  });
  try {
    const config = readModelConfig(
      configFile({ baseURL: `http://127.0.0.1:${server.port}/v1`, api_key_file: keyFile() }),
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      makeTransport(config)("/chat/completions", { method: "POST", body: "{}", signal: abort.signal }),
    ).rejects.toThrow();
    expect(called).toBe(0);
  } finally {
    server.stop(true);
  }
});
