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
