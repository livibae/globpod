/**
 * One-off: rebuild only the RSS feed XML on R2 (preserves existing episodes,
 * applies fresh channel metadata). Use when channel-level settings change.
 *
 * Run with: npx tsx src/regenFeed.ts
 */

import "dotenv/config";
import { fetchExistingFeed, uploadFeed } from "./pipeline/uploadToR2.js";
import { rebuildFeedMetadata } from "./pipeline/updateFeed.js";

async function main(): Promise<void> {
  console.log("[regen] Fetching existing feed…");
  const existing = await fetchExistingFeed();
  if (!existing) {
    console.error("[regen] No existing feed found — nothing to rebuild");
    process.exit(1);
  }

  console.log("[regen] Rebuilding feed metadata…");
  const updated = rebuildFeedMetadata(existing);

  console.log("[regen] Uploading new feed XML…");
  const url = await uploadFeed(updated);
  console.log(`[regen] Done → ${url}`);
}

main().catch((err) => {
  console.error("[regen] FAILED:", err.message);
  process.exit(1);
});
