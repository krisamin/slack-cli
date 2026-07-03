import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { slackApi } from "./api";
import type { Profile } from "./config";

export interface UserInfo {
  /** real_name, falling back to display_name then handle */
  realName: string;
  /** mention handle (user.name, e.g. jane.doe) */
  handle: string;
  isBot: boolean;
}

interface UsersInfoResponse {
  ok: boolean;
  user: {
    id: string;
    name: string;
    is_bot: boolean;
    profile: { display_name?: string; real_name?: string };
  };
}

const CACHE_DIR = join(homedir(), ".cache", "slack-cli");

const isUserInfo = (value: unknown): value is UserInfo => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.realName === "string" && typeof obj.handle === "string" && typeof obj.isBot === "boolean";
};

export class UserResolver {
  private cache: Record<string, UserInfo> = {};
  private dirty = false;
  private readonly cachePath: string;

  constructor(
    private readonly profile: Profile,
    profileName: string,
  ) {
    this.cachePath = join(CACHE_DIR, `users-${profileName}.json`);
  }

  async load(): Promise<void> {
    const file = Bun.file(this.cachePath);
    if (await file.exists()) {
      try {
        const raw = (await file.json()) as Record<string, unknown>;
        for (const [id, value] of Object.entries(raw)) {
          if (isUserInfo(value)) this.cache[id] = value; // drop stale-format entries, re-fetch
        }
      } catch {
        this.cache = {};
      }
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    mkdirSync(CACHE_DIR, { recursive: true });
    await Bun.write(this.cachePath, `${JSON.stringify(this.cache, null, 2)}\n`);
  }

  async resolve(userId: string): Promise<UserInfo> {
    const cached = this.cache[userId];
    if (cached) return cached;
    let info: UserInfo;
    try {
      const res = await slackApi<UsersInfoResponse>(this.profile, "users.info", { user: userId });
      info = {
        realName: res.user.profile.real_name || res.user.profile.display_name || res.user.name,
        handle: res.user.name,
        isBot: res.user.is_bot,
      };
    } catch {
      info = { realName: userId, handle: userId, isBot: false };
    }
    this.cache[userId] = info;
    this.dirty = true;
    return info;
  }

  async resolveMany(userIds: Iterable<string>): Promise<Map<string, UserInfo>> {
    const result = new Map<string, UserInfo>();
    for (const id of new Set(userIds)) {
      result.set(id, await this.resolve(id));
    }
    return result;
  }
}
