import { slackApi } from "../api";
import { configPath, loadConfig, normalizeCookie, resolveProfile, saveConfig } from "../config";

interface AuthTestResponse {
  ok: boolean;
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
}

export const authTest = async (profileName?: string): Promise<string> => {
  const config = await loadConfig();
  const { name, profile } = resolveProfile(config, profileName);
  const res = await slackApi<AuthTestResponse>(profile, "auth.test");
  return [
    `✓ authenticated (profile: ${name})`,
    `  workspace : ${res.url}`,
    `  team      : ${res.team} (${res.team_id})`,
    `  user      : ${res.user} (${res.user_id})`,
  ].join("\n");
};

export const authSet = async (opts: {
  profile: string;
  token?: string;
  cookie?: string;
  setDefault: boolean;
}): Promise<string> => {
  const token = opts.token ?? (await promptHidden("xoxc token: "));
  const cookie = opts.cookie ?? (await promptHidden("d cookie (xoxd-...): "));

  if (!token.startsWith("xoxc-")) throw new Error("Token must start with xoxc-.");
  if (!cookie.startsWith("xoxd-")) throw new Error("Cookie must start with xoxd-.");

  const config = await loadConfig();
  config.profiles[opts.profile] = { token, cookie: normalizeCookie(cookie) };
  if (opts.setDefault || !config.default) config.default = opts.profile;
  await saveConfig(config);

  return `Profile '${opts.profile}' saved (${configPath})\n${await authTest(opts.profile)}`;
};

/** Interactive prompt: CLI only. The MCP server never reaches this path. */
const promptHidden = async (label: string): Promise<string> => {
  process.stdout.write(label);
  for await (const line of console) {
    return line.trim();
  }
  throw new Error("No input received.");
};
