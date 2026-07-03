import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveProfile } from "../config";
import type { SlackFile } from "../render";
import { parseSlackUrl } from "../url";
import { fetchThread } from "./read";

/** Download every attachment in a thread. url_private requires the xoxc token + d cookie. */
export const file = async (url: string, opts: { profile?: string; out?: string }): Promise<void> => {
  const config = await loadConfig();
  const { profile } = resolveProfile(config, opts.profile);
  const parsed = parseSlackUrl(url);
  if (!parsed.threadTs) throw new Error("URL has no message ts.");

  const messages = await fetchThread(profile, parsed.channelId, parsed.threadTs);
  const fileList: SlackFile[] = messages.flatMap((m) => m.files ?? []);
  if (!fileList.length) {
    console.log("No attachments in this thread.");
    return;
  }

  const outDir = opts.out ?? join("/tmp", `slack-files-${parsed.threadTs.replace(".", "")}`);
  mkdirSync(outDir, { recursive: true });

  let saved = 0;
  for (const file of fileList) {
    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) {
      console.log(`- ${file.name ?? file.id}: no download URL (external file?)`);
      continue;
    }
    const safeName = `${file.id ?? saved}-${(file.name ?? "file").replace(/[/\\]/g, "_")}`;
    const dest = join(outDir, safeName);
    const res = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${profile.token}`,
        Cookie: `d=${profile.cookie}`,
      },
    });
    if (!res.ok) {
      console.log(`- ${file.name}: HTTP ${res.status}`);
      continue;
    }
    const buf = await res.arrayBuffer();
    // On auth failure Slack returns an HTML login page with status 200 — detect it
    const head = new TextDecoder().decode(buf.slice(0, 15)).toLowerCase();
    if (head.startsWith("<!doctype html") && !(file.mimetype ?? "").includes("html")) {
      console.log(`- ${file.name}: auth failed (got HTML back) — check your token/cookie`);
      continue;
    }
    await Bun.write(dest, buf);
    console.log(`✓ ${dest} (${(buf.byteLength / 1024).toFixed(1)} KB, ${file.mimetype ?? "?"})`);
    saved++;
  }
  console.log(`\nSaved ${saved}/${fileList.length} → ${outDir}`);
};
