import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Profile {
  token: string;
  cookie: string;
}

export interface Config {
  default?: string;
  profiles: Record<string, Profile>;
}

const CONFIG_DIR = join(homedir(), ".config", "slack-cli");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export const loadConfig = async (): Promise<Config> => {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) return { profiles: {} };
  return (await file.json()) as Config;
};

export const saveConfig = async (config: Config): Promise<void> => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  await Bun.write(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(CONFIG_PATH, 0o600);
};

export const resolveProfile = (config: Config, name?: string): { name: string; profile: Profile } => {
  const profileName = name ?? process.env.SLACK_PROFILE ?? config.default;
  if (!profileName) {
    throw new Error("No profile configured. Run `slack auth set --profile <name>` first.");
  }
  const profile = config.profiles[profileName];
  if (!profile) {
    const available = Object.keys(config.profiles).join(", ") || "(none)";
    throw new Error(`Profile '${profileName}' not found. Available: ${available}`);
  }
  return { name: profileName, profile };
};

/** Raw xoxd cookie values contain / + = which must be URL-encoded for the Cookie header. */
export const normalizeCookie = (value: string): string => {
  if (/%[0-9A-Fa-f]{2}/.test(value)) return value; // already encoded
  return encodeURIComponent(value);
};

export const configPath = CONFIG_PATH;
