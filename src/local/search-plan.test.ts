import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore, parseSearch } from "./store";

let directory = "";
let path = "";
const schema = `CREATE TABLE message (
  channel_id TEXT,ts TEXT,thread_ts TEXT,user TEXT,text TEXT,bot INTEGER,deleted INTEGER,
  edited_ts TEXT,reply_count INTEGER,latest_reply TEXT,seen_at INTEGER,PRIMARY KEY(channel_id,ts));
  CREATE INDEX message_ts ON message(ts);
  CREATE INDEX message_thread ON message(channel_id,thread_ts);
  CREATE TABLE state (key TEXT PRIMARY KEY,value TEXT);`;
const populate = (db: Database) => {
  const insert = db.query("INSERT INTO message VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 20_001; i++) {
      const ts = `1790${String(i).padStart(6, "0")}.000001`;
      insert.run(
        i % 2 ? "CTEST2" : "CTEST1",
        ts,
        ts,
        i % 3 ? "UTEST2" : "UTEST1",
        i === 0
          ? "older excluded needle"
          : i === 1
            ? "boundary needle"
            : i === 20_000
              ? "ADMIN-API 제거"
              : "ordinary human",
        0,
        0,
        "",
        0,
        "",
        1,
      );
    }
    // Metadata filtering must happen BEFORE the latest 20,000 candidate cap.
    for (let i = 0; i < 20_005; i++) {
      const ts = `1791${String(i).padStart(6, "0")}.000001`;
      insert.run("CTEST1", ts, ts, "UTEST2", "bot only needle", 1, 0, "", 0, "", 1);
    }
    insert.run("CTEST1", "1792999999.000001", "1792999999.000001", "UTEST1", "deleted needle", 0, 1, "", 0, "", 1);
    db.query("INSERT INTO state VALUES ('last_sync','1793000000')").run();
  })();
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "slack-search-plan-"));
  path = join(directory, "synthetic.db");
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const withIndex = (enabled: boolean): void => {
  const db = new Database(path, { create: true });
  db.exec(schema);
  populate(db);
  if (enabled) db.exec("CREATE INDEX message_human_ts ON message(ts) WHERE deleted=0 AND bot=0");
  db.close();
};

test("a collector-owned partial index serves the fixed human count and candidate order", () => {
  withIndex(true);
  const before = readFileSync(path);
  const store = new LocalStore(path);
  try {
    const count = store.db
      .query("EXPLAIN QUERY PLAN SELECT COUNT(*) n FROM (SELECT 1 FROM message WHERE deleted=0 AND bot=0 LIMIT ?)")
      .all(20_001);
    const candidate = store.db
      .query(
        "EXPLAIN QUERY PLAN SELECT channel_id,ts,text FROM message WHERE deleted=0 AND bot=0 ORDER BY ts DESC LIMIT ?",
      )
      .all(20_000);
    expect(JSON.stringify(count)).toContain("message_human_ts");
    expect(JSON.stringify(candidate)).toContain("message_human_ts");
    expect(JSON.stringify(candidate)).not.toContain("TEMP B-TREE");
    const r = store.search({ query: "ADMIN-api 제거", limit: 1 });
    expect(r.message_list.map((row) => row.ts)).toEqual(["1790020000.000001"]);
    expect(r.scanned_count).toBe(20_000);
    expect(r.scan_truncated).toBe(true);
    expect(r.hit_limit_reached).toBe(false);
  } finally {
    store.close();
  }
  expect(readFileSync(path)).toEqual(before);
});

test("latest matching metadata human cap and AND semantics are unchanged with or without an index", () => {
  withIndex(false);
  const store = new LocalStore(path);
  const requestList = [
    { query: "needle" },
    { query: "bot needle", include_bot: true },
    { query: "needle", channel_id: "CTEST1" },
    { query: "ordinary", user_id: "UTEST1", limit: 3 },
    { query: "ordinary human", channel_id: "CTEST2", since: "2026-09-21", until: "2026-09-23", limit: 3 },
    { query: "boundary needle", limit: 1 },
    { query: "older excluded needle", limit: 1 },
  ];
  const plain = requestList.map((input) => store.search(parseSearch(input)));
  store.close();
  const db = new Database(path);
  db.exec("CREATE INDEX message_human_ts ON message(ts) WHERE deleted=0 AND bot=0");
  db.close();
  const indexed = new LocalStore(path);
  try {
    const normalize = (r: ReturnType<LocalStore["search"]>) => ({ ...r, freshness: undefined });
    expect(requestList.map((input) => normalize(indexed.search(parseSearch(input))))).toEqual(plain.map(normalize));
    expect(indexed.search({ query: "boundary needle" }).message_list).toHaveLength(1);
    expect(indexed.search({ query: "older excluded needle" }).message_list).toHaveLength(0);
    expect(indexed.search({ query: "needle" }).message_list.every((row) => row.bot === 0 && row.deleted === 0)).toBe(
      true,
    );
  } finally {
    indexed.close();
  }
});

test("count projection contains no text or ORDER BY, and the reader never creates indices", () => {
  withIndex(false);
  const before = readFileSync(path);
  const store = new LocalStore(path);
  const countSql: string[] = [];
  const original = store.db.query.bind(store.db);
  store.db.query = ((sql: string) => {
    if (sql.startsWith("SELECT COUNT(*) n FROM (")) countSql.push(sql);
    return original(sql);
  }) as typeof store.db.query;
  try {
    store.search({ query: "admin-api 제거" });
  } finally {
    store.close();
  }
  expect(countSql).toHaveLength(1);
  expect(countSql[0]).toContain("SELECT 1 FROM message");
  expect(countSql[0]).not.toContain("ORDER BY");
  expect(countSql[0]).not.toContain("text");
  const check = new Database(`file:${path}?mode=ro`, 1 | 64);
  expect(check.query("SELECT name FROM sqlite_schema WHERE type='index' AND name='message_human_ts'").get()).toBeNull();
  check.close();
  expect(readFileSync(path)).toEqual(before);
});

test("the collector schema creates its partial index only in a synthetic HOME database", async () => {
  const home = join(directory, "collector-home");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    globalThis.fetch = async () => { throw new Error("Network forbidden in schema test."); };
    const { openStore } = await import(process.env.TEST_STORE_SOURCE);
    const db = openStore("synthetic.db");
    const index = db.query("SELECT name,sql FROM sqlite_schema WHERE type='index' AND name='message_human_ts'").get();
    db.close();
    console.log(JSON.stringify({index}));
  `,
    ],
    {
      env: { PATH: process.env.PATH ?? "", HOME: home, TEST_STORE_SOURCE: join(import.meta.dir, "../inbox/store.ts") },
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
  expect(JSON.parse(output).index).toEqual({
    name: "message_human_ts",
    sql: "CREATE INDEX message_human_ts ON message (ts) WHERE deleted=0 AND bot=0",
  });
});
