/**
 * GlobPod pipeline orchestrator.
 *
 * Wires all pipeline steps in sequence:
 *   fetch → script → audio → upload MP3 → fetch feed → update feed → upload feed
 *   → blacklist used articles
 *
 * Articles are only written to SQLite after a successful publish (LIV-8),
 * so a failed run does not burn the candidate pool.
 *
 * Each step is wrapped in error handling — on failure, an alert email is sent
 * before the error propagates and halts the run.
 *
 * Run manually with: npm run run-once  (or npm run dev for ts-node)
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import { purgeOldArticles, markArticlesUsed } from "./db/sqlite.js";
import { fetchArticles } from "./pipeline/fetchArticles.js";
import { generateScript, allCandidates } from "./pipeline/generateScript.js";
import { generateAudio, fetchElevenLabsQuota, isQuotaWarning, inferSegmentsFromScript } from "./pipeline/generateAudio.js";
import { uploadMp3, fetchExistingFeed, uploadFeed } from "./pipeline/uploadToR2.js";
import { buildUpdatedFeed } from "./pipeline/updateFeed.js";
import { sendErrorEmail, sendQuotaWarningEmail } from "./notify.js";
import type { Article } from "./pipeline/fetchArticles.js";

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

  // 2. Fetch articles (read-only against SQLite — does not blacklist)
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

  // 3. Generate podcast script via Claude (also returns used article IDs + blurb)
  const { script, segments, usedArticleIds, usedFallback, summary } = await step(
    "generateScript",
    () => generateScript(articles)
  );

  let audioSegments = segments;
  if (audioSegments.filter((s) => s.lang === "yue").length === 0) {
    console.warn("[audio] WARN: no Cantonese segments — inferring from script line breaks");
    audioSegments = inferSegmentsFromScript(script);
  }

  // 3b. ElevenLabs quota check — warn early, never block the run
  try {
    const quota = await fetchElevenLabsQuota();
    if (quota) {
      const pct = Math.round(quota.ratio * 100);
      console.log(
        `[quota] ElevenLabs usage: ${quota.characterCount}/${quota.characterLimit} (${pct}%)`
      );
      if (isQuotaWarning(quota)) {
        await sendQuotaWarningEmail(quota);
      }
    }
  } catch (err) {
    console.warn(
      "[quota] WARN: could not fetch ElevenLabs usage:",
      err instanceof Error ? err.message : err
    );
  }

  // 4. Generate MP3 audio via ElevenLabs + Edge Cantonese
  const audioBuffer = await step("generateAudio", () => generateAudio(audioSegments));

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
      summary,
    })
  );

  // 8. Upload updated feed XML to R2
  const feedUrl = await step("uploadFeed", () => uploadFeed(updatedFeedXml));

  // 9. Blacklist only the articles that made it into this published episode.
  //    Done AFTER a successful publish so failed runs don't burn candidates (LIV-8).
  try {
    const byId = new Map(allCandidates(articles).map((a) => [a.id, a]));
    // If fallback already expanded to all candidates, usedArticleIds is that set.
    // Still resolve against the candidate map so we have full metadata to store.
    const toMark: Article[] = [];
    for (const id of usedArticleIds) {
      const article = byId.get(id);
      if (article) toMark.push(article);
    }

    const usedAt = new Date().toISOString();
    const written = markArticlesUsed(
      toMark.map((a) => ({
        id: a.id,
        title: a.title,
        feed_source: a.feedName,
        region: a.region,
        pub_date: a.pubDate.toISOString(),
        used_at: usedAt,
      }))
    );
    console.log(
      `[db] Blacklisted ${written} used article(s)` +
        (usedFallback ? " (fallback: all candidates shown to Claude)" : "")
    );
  } catch (err) {
    // Non-fatal for the listener — episode is already live — but log loudly:
    // without this write, the next run may re-use the same stories.
    console.error(
      "[db] ERROR: failed to blacklist used articles:",
      err instanceof Error ? err.message : err
    );
  }

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
