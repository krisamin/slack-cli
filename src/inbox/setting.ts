import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-user inbox settings. Lives next to the CLI config, never in the repo:
 * channel names and your own name are workspace details.
 */
export interface InboxSetting {
  /** Plain-text spellings of your name that count as a mention (case-insensitive). */
  nameList: string[];
  /** Channels whose every message matters (exact names). */
  watchList: string[];
  /** Channels whose name starts with one of these are watched too. */
  watchPrefixList: string[];
  /** Bot / alert channels: counted, never listed (unless you are named). */
  botList: string[];
  /** Channels to ignore except for direct mentions. */
  muteList: string[];
  /**
   * "grade:reason" pairs that never wake the poller on their own, e.g.
   * "watch:@here" or "normal:@backend". Those items wait for the briefing.
   */
  quietWakeList: string[];
  /** How far back each sync re-reads, to catch search-index lag. */
  overlapSecond: number;
  /** A channel with at least this many messages in 7 days and a human share below botShare is graded bot. */
  botMinMessage: number;
  botShare: number;
}

export const SETTING_PATH = join(homedir(), ".config", "slack-cli", "inbox.json");

const DEFAULT_SETTING: InboxSetting = {
  nameList: [],
  watchList: [],
  watchPrefixList: [],
  botList: [],
  muteList: [],
  quietWakeList: [],
  overlapSecond: 900,
  botMinMessage: 30,
  botShare: 0.1,
};

export const loadSetting = async (): Promise<InboxSetting> => {
  const file = Bun.file(SETTING_PATH);
  if (!(await file.exists())) return { ...DEFAULT_SETTING };
  return { ...DEFAULT_SETTING, ...((await file.json()) as Partial<InboxSetting>) };
};

/** Grade set in the settings file, if any. Auto grading fills the rest. */
export const explicitGrade = (setting: InboxSetting, name: string): string | undefined => {
  if (setting.muteList.includes(name)) return "mute";
  if (setting.botList.includes(name)) return "bot";
  if (setting.watchList.includes(name)) return "watch";
  if (setting.watchPrefixList.some((prefix) => name.startsWith(prefix))) return "watch";
  return undefined;
};
