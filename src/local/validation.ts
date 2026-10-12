export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
};

export const keys = (input: Record<string, unknown>, allowed: readonly string[]): void => {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
  }
};

export const text = (value: unknown, name: string, max = 500, optional = false): string | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${name} must be a nonempty string of at most ${max} characters.`);
  }
  return value;
};

export const integer = (value: unknown, name: string, fallback: number, max: number): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}.`);
  }
  return value;
};

export const boolean = (value: unknown, name: string, fallback = false): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
};

export const channelId = (value: unknown): string => {
  const result = text(value, "channel_id", 32);
  if (!result || !/^[CDG][A-Z0-9]+$/.test(result)) throw new Error("Invalid channel_id.");
  return result;
};

export const timestamp = (value: unknown): string => {
  const result = text(value, "root_ts", 24);
  if (!result || !/^\d{10}\.\d{6}$/.test(result)) throw new Error("Invalid Slack timestamp.");
  return result;
};

export const dateSecond = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  const result = text(value, name, 40);
  if (!result || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(result)) {
    throw new Error(`${name} must be YYYY-MM-DD (UTC) or an ISO timestamp with a timezone.`);
  }
  const datePart = result.slice(0, 10);
  if (new Date(`${datePart}T00:00:00Z`).toISOString().slice(0, 10) !== datePart) throw new Error(`Invalid ${name}.`);
  const second = Date.parse(result) / 1000;
  if (!Number.isFinite(second)) throw new Error(`Invalid ${name}.`);
  return second;
};
