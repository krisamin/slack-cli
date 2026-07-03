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

export const authTest = async (profileName?: string): Promise<void> => {
  const config = await loadConfig();
  const { name, profile } = resolveProfile(config, profileName);
  const res = await slackApi<AuthTestResponse>(profile, "auth.test");
  console.log(`✓ authenticated (profile: ${name})`);
  console.log(`  workspace : ${res.url}`);
  console.log(`  team      : ${res.team} (${res.team_id})`);
  console.log(`  user      : ${res.user} (${res.user_id})`);
};

export const authSet = async (opts: {
  profile: string;
  token?: string;
  cookie?: string;
  setDefault: boolean;
}): Promise<void> => {
  const token = opts.token ?? (await promptHidden("xoxc token: "));
  const cookie = opts.cookie ?? (await promptHidden("d cookie (xoxd-...): "));

  if (!token.startsWith("xoxc-")) throw new Error("Token must start with xoxc-.");
  if (!cookie.startsWith("xoxd-")) throw new Error("Cookie must start with xoxd-.");

  const config = await loadConfig();
  config.profiles[opts.profile] = { token, cookie: normalizeCookie(cookie) };
  if (opts.setDefault || !config.default) config.default = opts.profile;
  await saveConfig(config);

  console.log(`Profile '${opts.profile}' saved (${configPath})`);
  await authTest(opts.profile);
};

const promptHidden = async (label: string): Promise<string> => {
  process.stdout.write(label);
  for await (const line of console) {
    return line.trim();
  }
  throw new Error("No input received.");
};
