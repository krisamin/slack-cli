# slack-cli

A Slack CLI I wrote for workspaces where I can't install bots. It authenticates
with your browser session (the `xoxc` token plus the `xoxd` cookie), so if you
can open Slack in a browser, you can use this.

Two things it does well: dumping a full thread as readable text, and staging
reply drafts through Slack's internal `drafts.*` API. Drafts land in the
compose box only — you review and hit send in Slack yourself. The CLI never
sends anything on your behalf, which is the whole point: I use it to prepare
replies programmatically without giving anything the power to speak as me.

## Install

Requires [Bun](https://bun.sh).

```bash
bun install
bun link   # registers the global `slack` command
```

## Authentication

Grab both values from Slack in your browser (must be signed in to the workspace):

- **xoxc token**: DevTools → Console →
  ```js
  JSON.parse(localStorage.localConfig_v2).teams[Object.keys(JSON.parse(localStorage.localConfig_v2).teams)[0]].token
  ```
- **d cookie**: DevTools → Application → Cookies → `https://{workspace}.slack.com` → `d`
  (the value starts with `xoxd-`)

```bash
slack auth set --profile work --token 'xoxc-...' --cookie 'xoxd-...' --default
slack auth   # verify
```

Notes:

- The cookie's `/ + =` characters are URL-encoded for you.
- Both credentials are tied to the browser session. Logging out kills them
  **together** — when auth breaks, refresh both, not just one.
- Config lives in `~/.config/slack-cli/config.json` (chmod 0600).
  Resolved user names are cached in `~/.cache/slack-cli/`.

## Usage

```bash
# read a thread with replies (real names + handles resolved)
slack read 'https://myworkspace.slack.com/archives/C04XXXXXX/p1782090279095849'
slack read <url> --json   # raw message JSON

# every channel message in a range, oldest first. Thread roots get their reply
# count and a link you can hand straight to `slack read`; --thread inlines them.
# Times are local: YYYY-MM-DD, "YYYY-MM-DD HH:mm", 3d / 12h / 2w ago, or now.
slack history <channel-or-message-url> --since 2026-09-25            # until now
slack history <url> --since 2026-09-25 --until 2026-09-26            # two whole days
slack history <url> --since 3d --thread

# download every attachment in a thread
slack file <url> --out ./downloads

# ...or just the ones you want. Slack names are not unique, so `slack read`
# prints each attachment's id next to it: `file: image.png (image/png, F0ABC123)`
slack file <url> --file-id-list F0ABC123,F0DEF456

# stage a reply draft
slack draft write <url> -m "Looking into it."
slack draft write <url> -f reply.txt
echo "body" | slack draft write <url>

# manage drafts
slack draft list
slack draft rm <draft_id>
```

Multiple workspaces: pass `--profile <name>` or set `SLACK_PROFILE`.

## Read-only local analysis

`slack analyze` reads the existing inbox cache and optionally asks a **local**
OpenAI-compatible model. It never syncs Slack, changes inbox state, acknowledges
an item, stores a result, stages a draft or sends a message. Inbox collection
remains a separate command/process. These are advisory results, not an automation
or monitoring policy.

The cache must already exist at `~/.local/share/slack-cli/inbox.db`. The reader
uses a SQLite `file:...?mode=ro` URI with `SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`
and `PRAGMA query_only=ON`; it never uses `CREATE` or `immutable=1` (live WAL
updates remain visible). Workspace URL and self user ID come from the cache's
`state` table, not source-code constants. No Slack session token is needed for
these commands.

```bash
slack analyze metadata
slack analyze search 'review' --channel CEXAMPLE --user UEXAMPLE --limit 10
slack analyze search 'review change' --since 2026-10-01 --until 2026-10-02
slack analyze search 'deployment' --include-bot
slack analyze thread CEXAMPLE 1790000000.000001
slack analyze 'https://myworkspace.slack.com/archives/CEXAMPLE/p1790000000000001'
slack analyze ask 'Who currently owns the review?'
slack analyze thread CEXAMPLE 1790000000.000001 --mode batch
# Complex requests can explicitly enable thinking; the default is off.
slack analyze ask 'Compare the outstanding reviews' --think
```

All results are JSON. `search`, `thread` (MCP `local_thread`) and `metadata`
return cached data; CLI `analyze thread` runs the model. Date-only search filters
are UTC, `since` is inclusive, `until` exclusive; timestamps must include a
zone. Search splits the query into at most 5 whitespace-separated literal substring
terms, combined with AND (ASCII case-insensitive via SQLite `lower`). It is not
user-supplied SQL or Slack search syntax. Bot rows are excluded before the scan
cap unless `--include-bot` / `include_bot:true` explicitly opts in; thread reads
always retain bot messages. Hits include `root_ts` as an alias of `thread_ts`
for the next thread call. A no-hit result suggests dropping the least distinctive
term, rather than only widening dates. It scans at most the
latest 20,000 rows matching metadata filters and returns at most 50 hits,
with 600-character previews. `scan_truncated`/`hit_limit_reached` explicitly
report incomplete searches. Narrow the channel/date/author filters to inspect
older messages. SQL filters are fixed and bound.

Model configuration is private, separate from Slack authentication:

```bash
mkdir -p ~/.config/slack-cli
chmod 700 ~/.config/slack-cli
cat > ~/.config/slack-cli/model.json <<'JSON'
{
  "baseURL": "http://127.0.0.1:18080/v1",
  "model": "your-local-model-alias",
  "timeout_ms": 90000,
  "max_tokens": 1800
}
JSON
chmod 600 ~/.config/slack-cli/model.json
```

Only literal `127.0.0.1` or `[::1]` HTTP `/v1` endpoints are accepted; redirects,
remote/private-network URLs, URL credentials and extra configuration keys are
rejected. Use a private SSH tunnel for a model running on another machine.
There is no external API opt-in. The config must be an owned regular 0600 file,
not a symlink. The model needs OpenAI tools and `response_format: json_schema`
plus `chat_template_kwargs.enable_thinking` support. Investigation requests use
tools only; the final request uses JSON schema only, never both together.
A direct thread analysis goes straight to the schema-only final phase. Unsupported/incomplete
responses fail rather than silently falling back to unstructured output.

`ask` runs a real search → thread retrieval tool loop. Its only tools are
`search`, `thread` and `metadata` (strict runtime validation, no SQL interface).
The system prompt treats all cached/tool text as untrusted data, not
instructions. `reply_needed` and `task_open` refer only to the cached `self_user`'s
obligations. An unanswered direct question still needs a reply; a distinct
promised followup can remain open after a reply. `current_assignee_user_id`
identifies the salient current request's owner, even if another user, or is
null for closed/information-only cases. The deployment defaults are temperature
0, seed 42 and 1,800 output tokens; private comparative evaluations using 768
tokens are a different configuration and should not be conflated.

A successful response includes:

```json
{
  "status": "ok",
  "analysis": {
    "reply_needed": true,
    "task_open": true,
    "current_assignee_user_id": "UEXAMPLE",
    "deadline": null,
    "evidence": [{"channel_id": "CEXAMPLE", "ts": "1790000000.000001", "quote": "exact source substring"}],
    "needs_human": true,
    "summary": "A brief current-state summary."
  }
}
```

Evidence must reference actually read, nondeleted thread messages and match an
exact substring. Assignee IDs and deadlines must be grounded in that evidence;
deadlines are quoted, not normalized. Unknown reply/task states are `null` and
require human review. These checks establish grounding, **not semantic accuracy**.
The model may still misread reassignment or closure, or follow instructions
injected into message bodies despite the untrusted-data prompt. Every model
result is untrusted and includes `human_review_required:true`; it is **not an
autonomous acknowledgement or alert/monitoring replacement**. The code restricts
execution to three readonly tools, but that does not prove label robustness. Cached `body.reactions` are reduced to bounded names/user IDs/counts with
`reaction_state: cached`; missing/malformed/unbounded reaction data are
`unknown`, not proof of no reaction. Nearby channel replies, images and linked
documents are not expanded. Do not treat a cached
absence as proof that nobody replied or completed a task.

Each thread preserves the entire root plus a bounded recent tail (at most 200
replies and a 24,000-character text budget). It fails explicitly if the root
alone is too large; it never silently cuts it. Results report omitted message
IDs/counts (ID list capped at 1,000), cache incompleteness and thread fetch time.
Any truncation/incompleteness forces `needs_human`. Each read reports `fetched_at`,
`last_sync`/`asof` (cache sync epoch string), schema/data version and a database
fingerprint. Changes during analysis also force review. No freshness claim is
made about Slack beyond what the separate collector last cached. Edits newer
than `last_sync` set `edit_after_asof` and require review. Historical text cannot
be reconstructed from the latest stored row; `historical_reconstruction_supported`
is always false.

Resource limits: fixed SQLite reads run in a killable subprocess with a 3-second
wall deadline; model calls have configurable timeouts up to 120 seconds and
4,096 output tokens. Each analysis is at most 6 model requests including its final schema step/12 tool calls,
50,000 characters per tool result, 100,000 cumulative context characters and
1 MB per response. `finish_reason: length`, malformed JSON, unknown tool
arguments, invalid evidence or exceeded limits fail closed. Foreground analysis
has a 120-second total budget; batch work is one short unit with a 30-second
budget. A private PID lock admits only one analysis across CLI/MCP processes.
After a forcibly killed process, verify its PID is dead and remove the private
`~/.cache/slack-cli/local-model/inference.lock` manually; uncertain locks skip.

Batch also checks the model's `/health` and `/slots` (llama.cpp-style
`status: ok`, `is_processing`). Busy, missing or unknown capacity returns
`status: busy` without submitting inference. Foreground never changes model
scheduling or the GPU deployment. Batch does not schedule itself; call it from
your own explicit workload. Results are printed/returned only, not persisted.

Developer APIs: `src/local/store.ts` exports `openLocalStore({dbPath?})` and a
synchronous `LocalStore` (`search`, `thread`, `metadata`, `freshness`, `close`).
`src/local/read.ts` is the production timeout-isolated read boundary.
`src/local/analysis.ts` exports `analyzeThread({channel_id,root_ts,mode?,think?})`
and `askLocal({question,mode?,think?})`, with injectable store/config/transport
for private evaluations and synthetic tests. Do not commit real Slack fixtures
or model outputs to this repository.

Validation: `bun test`, `bun run typecheck`, `bun run lint`. Tests use only
synthetic messages and a temporary cache; no Slack writes or external model
calls are needed.

### Optional model authentication

The model configuration can reference a private key file with `api_key_file`.
It does not store the key itself:

```json
{
  "baseURL": "http://127.0.0.1:18080/v1",
  "model": "local-multimodal",
  "timeout_ms": 120000,
  "max_tokens": 1800,
  "api_key_file": "/absolute/private/directory/app-key"
}
```

The key file must be a regular file owned by the current user with permissions
exactly `0600`. Its content is one nonempty printable ASCII token, at most 4096
bytes, optionally followed by one newline. Relative paths, final symlinks,
missing files, a non-private parent directory, unsafe permissions, empty content and multiline values are
rejected before an HTTP request. The key is re-read for each request, sent only
as a Bearer header, and is never included in parsed configuration or errors.
Literal loopback `/v1` addresses and redirect rejection remain mandatory.

Omitting `api_key_file` preserves the existing direct no-auth model path.
A configured but invalid file never falls back to no-auth. Raw cache metadata,
search and thread tools do not read model configuration or keys. The direct
`/health` and `/slots` batch checks use the same optional header; these status
reads do not provide global atomic admission across applications. A gateway's
separate admission contract must be validated before routing batch work to it.

### Gateway admission

Set `"admission": "gateway"` in the private model configuration only after the
non-streaming gateway contract has been validated. This opt-in requires
`api_key_file`. Omitting `admission`, or setting it to `"direct"`, preserves the
existing direct `/health` and `/slots` batch preflight.

Gateway mode does not read private runtime status. Each completion POST is
admitted atomically by the gateway. Initial deployment is one replica and one
worker with one shared physical backend, one in-flight request and no queue.
Only HTTP `503` with JSON `error.type === "overloaded_error"` and string
`error.code === "503"` is a batch `status:"busy"` skip. Foreground returns an
explicit retry-later error. Upstream `503`, another error type/code, `401`/`403`,
connection failure or invalid JSON remain errors, not successful analysis or
an admission skip. Requests are not retried automatically.

The caller deadline covers headers and the full response body and aborts the
same HTTP chain. Foreground total remains 120 seconds, batch 30 seconds and
these two MCP tools declare 150 seconds. No new deadline or priority headers
are sent, and the current non-streaming payload is unchanged. Gateway provider
read timeouts are not an absolute SSE-body guarantee. Single-worker admission
is not an HA global limit, and mock cancellation is not proof of GPU slot
release; those operating gates require separate acceptance.

## MCP server

`slack mcp` serves the same commands as MCP tools over stdio, so an assistant
can read threads and stage drafts without shelling out to the CLI.

| tool | arguments |
| --- | --- |
| `thread_read` | `url`, `json`, `profile` |
| `channel_history` | `url`, `since`, `until`, `include_thread`, `json`, `profile` |
| `thread_file` | `url`, `file_id_list`, `out`, `profile` |
| `draft_write` | `url`, `message`, `broadcast`, `profile` |
| `draft_list` | `json`, `profile` |
| `draft_rm` | `draft_id`, `profile` |
| `auth_test` | `profile` |
| `local_search` | `query`, `channel_id`, `user_id`, `since`, `until`, `limit`, `include_bot` |
| `local_thread` | `channel_id`, `root_ts` |
| `local_metadata` | none |
| `local_analyze` | `channel_id`, `root_ts`, `mode`, `think` |
| `local_ask` | `question`, `mode`, `think` |

The same rule applies here: `draft_write` stages a draft and nothing sends it
but you.

Register it with any MCP host that speaks stdio, pointing at the `slack`
executable with the `mcp` argument:

```json
{
  "command": "/absolute/path/to/.bun/bin/bun",
  "args": ["run", "/absolute/path/to/.bun/bin/slack", "mcp"]
}
```

Call Bun by absolute path and pass the script as an argument. MCP hosts are
spawned from a shell that never sourced your profile, so `~/.bun/bin` is not on
`PATH`, and `slack` starts with `#!/usr/bin/env bun`: pointing the host straight
at it fails with `env: 'bun': No such file or directory`.

Only `local_ask` and `local_analyze` advertise `_meta["ax.ara/timeoutMs"] = 150000` to ara device hosts. This transport allowance leaves room outside the
analysis foreground limit of 120 seconds; it does not increase the model or
batch budgets. Raw local reads and the seven existing tools declare no override.
Other MCP hosts may ignore this optional extension and set their own deadlines.

The server advertises readonly annotations for local tools, distinguishes explicit
null request IDs from notifications, and drains pending calls after stdin EOF.
The server implements `initialize`, `tools/list`, `tools/call` and `ping` by
hand, with no MCP SDK dependency, which keeps this package free of runtime
dependencies.

## Caveats

- `drafts.*` is Slack's internal API, not the public platform API. It can
  change without notice. It has already cost me a few surprises: `drafts.list`
  returns deleted/sent tombstones that need filtering, and deleting a draft
  the Slack app has touched throws `draft_has_conflict` (the CLI works around
  it by claiming a future `client_last_updated_ts`).
- There is no draft edit API. Editing means `rm` then `write` again.
- File downloads can fail "successfully": on bad auth Slack returns an HTML
  login page with HTTP 200. The CLI sniffs for that and tells you instead of
  saving garbage.
- Session tokens have your permissions. Treat the config file like a password.

## License

MIT
