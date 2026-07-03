#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" };
import { authSet, authTest } from "./commands/auth";
import { draftList, draftRemove, draftWrite } from "./commands/draft";
import { file } from "./commands/file";
import { read } from "./commands/read";

const HELP = `slack — Slack CLI that runs on your browser session (xoxc token + xoxd cookie)

Usage:
  slack auth [--profile <name>]              check who you are signed in as (auth.test)
  slack auth set --profile <name> [options]  add or update a profile
      --token <xoxc-...>    session token (prompted if omitted)
      --cookie <xoxd-...>   d cookie (prompted if omitted, URL-encoded automatically)
      --default             make this the default profile
  slack read <url> [--json]                  print a thread with all replies
  slack file <url> [--out <dir>]             download thread attachments (default: /tmp)
  slack draft write <url> [-m <text> | -f <file>] [--broadcast]
                                             stage a reply draft (stdin works too)
  slack draft list [--json]                  list pending drafts
  slack draft rm <draft_id>                  delete a draft

Options:
  --profile <name>   profile to use (default: config default, or $SLACK_PROFILE)
  --version          print version
  -h, --help         show this help

Config: ~/.config/slack-cli/config.json
`;

/** Flags that consume the next argument as their value. Everything else is boolean. */
const VALUE_FLAGS = new Set(["profile", "token", "cookie", "out"]);

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-h") {
      flags.help = true;
    } else if (arg === "-m" || arg === "-f") {
      const key = arg === "-m" ? "message" : "file";
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} requires a value.`);
      flags[key] = next;
      i++;
    } else if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined) throw new Error(`--${body} requires a value.`);
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
};

const str = (value: string | boolean | undefined): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

const main = async (): Promise<void> => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  if (flags.version === true) {
    console.log(pkg.version);
    return;
  }
  if (!command || flags.help === true) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "auth": {
      if (rest[0] === "set") {
        const profileName = str(flags.profile);
        if (!profileName) throw new Error("--profile <name> is required.");
        await authSet({
          profile: profileName,
          token: str(flags.token),
          cookie: str(flags.cookie),
          setDefault: flags.default === true,
        });
      } else {
        await authTest(str(flags.profile));
      }
      break;
    }
    case "read": {
      const url = rest[0];
      if (!url) throw new Error("Usage: slack read <url>");
      await read(url, { profile: str(flags.profile), json: flags.json === true });
      break;
    }
    case "file": {
      const url = rest[0];
      if (!url) throw new Error("Usage: slack file <url> [--out <dir>]");
      await file(url, { profile: str(flags.profile), out: str(flags.out) });
      break;
    }
    case "draft": {
      const sub = rest[0];
      if (sub === "write") {
        const url = rest[1];
        if (!url) throw new Error("Usage: slack draft write <url> [-m <text> | -f <file>]");
        await draftWrite(url, {
          profile: str(flags.profile),
          message: str(flags.message),
          file: str(flags.file),
          broadcast: flags.broadcast === true,
        });
      } else if (sub === "list") {
        await draftList({ profile: str(flags.profile), json: flags.json === true });
      } else if (sub === "rm") {
        const draftId = rest[1];
        if (!draftId) throw new Error("Usage: slack draft rm <draft_id>");
        await draftRemove(draftId, { profile: str(flags.profile) });
      } else {
        throw new Error(`Unknown draft subcommand: ${sub ?? "(none)"} — expected write, list, or rm.`);
      }
      break;
    }
    default:
      console.log(HELP);
      throw new Error(`Unknown command: ${command}`);
  }
};

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
