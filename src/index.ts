/**
 * GlobPod pipeline orchestrator.
 *
 * Wires all pipeline steps in sequence:
 *   fetch → script → audio → upload MP3 → fetch feed → update feed → upload feed
 *
 * Each step is wrapped in error handling — on failure, an alert email is sent
 * before the error propagates and halts the run.
 *
 * Run manually with: npm run run-once  (or npm run dev for ts-node)
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import { purgeOldArticles } from "./db/sqlite.js";
import { fetchArticles } from "./pipeline/fetchArticles.js";
import { generateScript } from "./pipeline/generateScript.js";
import { generateAudio } from "./pipeline/generateAudio.js";
import { uploadMp3, fetchExistingFeed, uploadFeed } from "./pipeline/uploadToR2.js";
import { buildUpdatedFeed } from "./pipeline/updateFeed.js";
import { sendErrorEmail } from "./notify.js";

// ---------------------------------------------------------------------------
// Step runner with error notification
// ---------------------------------------------------------------------------

/**
 * Execute a named pipeline step.
 * On failure: sends an error email and re-throws so the pipeline stops.
 */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n→ [${name}]`);
  try {
    const result = await fn();
    console.log(`✓ [${name}] done`);
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`✗ [${name}] FAILED:`, error.message);
    await sendErrorEmail(name, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runPipeline(): Promise<void> {
  const startTime = Date.now();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  console.log(`\n====== GlobPod pipeline starting (${today}) ======`);

  // 1. Purge stale articles from SQLite (housekeeping, non-critical)
  try {
    const purged = purgeOldArticles();
    if (purged > 0) console.log(`[db] Purged ${purged} old article(s)`);
  } catch {
    // Non-fatal — don't abort the run over housekeeping
    console.warn("[db] WARN: failed to purge old articles");
  }

  // 2. Fetch and deduplicate articles from all feeds
  const articles = await step("fetchArticles", () => fetchArticles());

  // 2b. Skip episode generation if too few articles — prevents wasted TTS credits
  //     on thin AI-padded content when no real news is available.
  const totalArticles = articles.hk.length + articles.uk.length + articles.nl.length;
  const minArticles = Number(process.env.MIN_ARTICLES_FOR_EPISODE ?? 5);
  if (totalArticles < minArticles) {
    console.log(
      `\n[skip] Only ${totalArticles} new article(s) (threshold: ${minArticles}). Skipping episode generation.`
    );
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n====== GlobPod pipeline finished early (${elapsed}s) ======`);
    return;
  }

  // 3. Generate podcast script via Claude
  const script = await step("generateScript", () => generateScript(articles));

  // 4. Generate MP3 audio via ElevenLabs
  const audioBuffer = await step("generateAudio", () => generateAudio(script));

  // 5. Upload MP3 to R2
  const audioUrl = await step("uploadMp3", () => uploadMp3(audioBuffer, today));

  // 6. Fetch existing RSS feed from R2 (null = first run)
  const existingFeed = await step("fetchExistingFeed", () => fetchExistingFeed());

  // 7. Build updated feed XML with the new episode
  const updatedFeedXml = await step("buildUpdatedFeed", () =>
    buildUpdatedFeed(existingFeed, {
      date: today,
      audioUrl,
      audioBuffer,
      audioSize: audioBuffer.length,
    })
  );

  // 8. Upload updated feed XML to R2
  const feedUrl = await step("uploadFeed", () => uploadFeed(updatedFeedXml));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n====== GlobPod pipeline complete (${elapsed}s) ======`);
  console.log(`Episode: ${audioUrl}`);
  console.log(`Feed:    ${feedUrl}`);
}

// ---------------------------------------------------------------------------
// Entry point (when run directly)
// ---------------------------------------------------------------------------

// Only run when executed directly — not when imported by scheduler.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPipeline().catch((err) => {
    console.error("\nPipeline aborted:", err.message);
    process.exit(1);
  });
}
