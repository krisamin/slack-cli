import type { Profile } from "./config";

export interface SlackError {
  ok: false;
  error: string;
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack API ${method} failed: ${code}`);
  }
}

export const slackApi = async <T extends { ok: boolean }>(
  profile: Profile,
  method: string,
  params: Record<string, string> = {},
): Promise<T> => {
  const body = new URLSearchParams({ token: profile.token, ...params });
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `d=${profile.cookie}`,
    },
    body: body.toString(),
  });
  const data = (await res.json()) as T | SlackError;
  if (!data.ok) {
    const code = (data as SlackError).error ?? "unknown_error";
    if (code === "invalid_auth" || code === "not_authed") {
      throw new SlackApiError(
        method,
        `${code} — the xoxc token and d cookie expire together; refresh both with \`slack auth set\`.`,
      );
    }
    throw new SlackApiError(method, code);
  }
  return data as T;
};
