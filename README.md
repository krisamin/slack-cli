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

# download every attachment in a thread
slack file <url> --out ./downloads

# stage a reply draft
slack draft write <url> -m "Looking into it."
slack draft write <url> -f reply.txt
echo "body" | slack draft write <url>

# manage drafts
slack draft list
slack draft rm <draft_id>
```

Multiple workspaces: pass `--profile <name>` or set `SLACK_PROFILE`.

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
