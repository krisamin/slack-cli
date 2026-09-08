import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProfile } from "../config";
import type { SlackFile } from "../render";
import { parseSlackUrl } from "../url";
import { fetchThread } from "./read";

/**
 * Download attachments from a thread. url_private requires the xoxc token + d
 * cookie.
 *
 * fileIdList narrows it to specific attachments. Slack names are not unique —
 * a thread of screenshots is a stack of "image.png" — so the id printed by
 * `slack read` is the only way to name one of them.
 */
export const file = async (
  url: string,
  opts: { profile?: string; out?: string; fileIdList?: string[] },
): Promise<string> => {
  const config = await loadConfig();
  const { profile } = resolveProfile(config, opts.profile);
  const parsed = parseSlackUrl(url);
  if (!parsed.threadTs) throw new Error("URL has no message ts.");

  const messages = await fetchThread(profile, parsed.channelId, parsed.threadTs);
  const threadFileList: SlackFile[] = messages.flatMap((m) => m.files ?? []);
  if (!threadFileList.length) return "No attachments in this thread.";

  const wanted = opts.fileIdList;
  const fileList = wanted ? threadFileList.filter((entry) => entry.id && wanted.includes(entry.id)) : threadFileList;
  if (wanted) {
    // An id that matches nothing is a mistake worth naming: downloading zero
    // files and reporting success reads as "the thread had no attachments".
    const missingList = wanted.filter((id) => !threadFileList.some((entry) => entry.id === id));
    if (missingList.length) {
      const available = threadFileList.map((entry) => `${entry.id ?? "(no id)"} ${entry.name ?? ""}`.trim()).join(", ");
      throw new Error(`Not in this thread: ${missingList.join(", ")}. Available: ${available}`);
    }
  }

  const outDir = opts.out ?? join("/tmp", `slack-files-${parsed.threadTs.replace(".", "")}`);
  mkdirSync(outDir, { recursive: true });

  const out: string[] = [];
  let saved = 0;
  for (const entry of fileList) {
    const downloadUrl = entry.url_private_download ?? entry.url_private;
    if (!downloadUrl) {
      out.push(`- ${entry.name ?? entry.id}: no download URL (external file?)`);
      continue;
    }
    const safeName = `${entry.id ?? saved}-${(entry.name ?? "file").replace(/[/\\]/g, "_")}`;
    const dest = join(outDir, safeName);
    const res = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${profile.token}`,
        Cookie: `d=${profile.cookie}`,
      },
    });
    if (!res.ok) {
      out.push(`- ${entry.name}: HTTP ${res.status}`);
      continue;
    }
    const buf = await res.arrayBuffer();
    // On auth failure Slack returns an HTML login page with status 200 — detect it
    const head = new TextDecoder().decode(buf.slice(0, 15)).toLowerCase();
    if (head.startsWith("<!doctype html") && !(entry.mimetype ?? "").includes("html")) {
      out.push(`- ${entry.name}: auth failed (got HTML back) — check your token/cookie`);
      continue;
    }
    await Bun.write(dest, buf);
    out.push(`✓ ${dest} (${(buf.byteLength / 1024).toFixed(1)} KB, ${entry.mimetype ?? "?"})`);
    saved++;
  }
  out.push("", `Saved ${saved}/${fileList.length} → ${outDir}`);
  return out.join("\n");
};
