/**
 * Re-synthesize and re-upload an existing episode (e.g. fix Cantonese TTS).
 *
 * Reuses the same stories from the original publish (SQLite used_at rows),
 * regenerates script + audio, replaces the MP3 and feed item in place.
 * Does NOT blacklist articles again.
 *
 * Usage: npx tsx src/republishEpisode.ts 2026-08-23
 */

import "dotenv/config";
import { XMLParser } from "fast-xml-parser";
import { getUsedArticlesForDate } from "./db/sqlite.js";
import type { Article, GroupedArticles } from "./pipeline/fetchArticles.js";
import { fetchArticles } from "./pipeline/fetchArticles.js";
import { generateScript } from "./pipeline/generateScript.js";
import { generateAudio, inferSegmentsFromScript } from "./pipeline/generateAudio.js";
import { uploadMp3, fetchExistingFeed, uploadFeed } from "./pipeline/uploadToR2.js";
import { buildUpdatedFeed } from "./pipeline/updateFeed.js";
import { getPodcastConfig } from "./config/podcast.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function extractEpisodeSummary(feedXml: string, date: string): string | undefined {
  const parsed = xmlParser.parse(feedXml) as {
    rss?: { channel?: { item?: unknown } };
  };
  const raw = parsed.rss?.channel?.item;
  const items = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  const title = `${getPodcastConfig().title} — ${date}`;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.title === title) {
      const desc = row.description ?? row["itunes:summary"];
      if (typeof desc === "string" && desc.trim()) return desc.trim();
    }
  }
  return undefined;
}

function filterToUsedIds(
  grouped: GroupedArticles,
  usedIds: Set<string>
): GroupedArticles {
  const pick = (list: Article[]) => list.filter((a) => usedIds.has(a.id));
  return {
    hk: pick(grouped.hk),
    uk: pick(grouped.uk),
    nl: pick(grouped.nl),
  };
}

function articleFromRecord(row: {
  id: string;
  title: string;
  feed_source: string;
  region: string;
  pub_date: string;
}): Article {
  return {
    id: row.id,
    title: row.title,
    link: row.id.includes(":") ? row.id.split(":").slice(1).join(":") : row.id,
    summary: row.title,
    region: row.region as Article["region"],
    feedName: row.feed_source,
    pubDate: new Date(row.pub_date),
  };
}

async function main(): Promise<void> {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  console.log(`\n====== Republishing GlobPod episode ${date} ======`);

  const usedRows = getUsedArticlesForDate(date);
  if (usedRows.length === 0) {
    throw new Error(`No used articles in SQLite for ${date} — cannot republish`);
  }

  const usedIds = new Set(usedRows.map((r) => r.id));
  console.log(`[republish] ${usedIds.size} story id(s) from original publish`);

  const fetched = await fetchArticles({ includeUsed: true, maxAgeHours: 48 });
  let articles = filterToUsedIds(fetched, usedIds);

  // Backfill any RSS misses from SQLite metadata (summary will be thin).
  const foundIds = new Set(
    [...articles.hk, ...articles.uk, ...articles.nl].map((a) => a.id)
  );
  for (const row of usedRows) {
    if (!foundIds.has(row.id)) {
      const stub = articleFromRecord(row);
      articles[stub.region].push(stub);
      console.warn(`[republish] WARN: ${row.id} not in RSS — using SQLite stub`);
    }
  }

  const total =
    articles.hk.length + articles.uk.length + articles.nl.length;
  console.log(
    `[republish] Stories: HK=${articles.hk.length}, UK=${articles.uk.length}, NL=${articles.nl.length}`
  );
  if (total < usedIds.size) {
    throw new Error(
      `Only matched ${total}/${usedIds.size} stories — aborting republish`
    );
  }

  const existingFeed = await fetchExistingFeed();
  const preservedSummary = existingFeed
    ? extractEpisodeSummary(existingFeed, date)
    : undefined;
  if (preservedSummary) {
    console.log("[republish] Preserving existing episode blurb from feed");
  }

  console.log("\n→ [generateScript]");
  let { script, segments, summary } = await generateScript(articles);
  const yueSegments = segments.filter((s) => s.lang === "yue").length;
  if (yueSegments === 0) {
    console.warn(
      "[republish] WARN: no Cantonese segments in script JSON — inferring from line breaks"
    );
    segments = inferSegmentsFromScript(script);
  }
  console.log(
    `✓ [generateScript] done — ${segments.length} audio segment(s), ${segments.filter((s) => s.lang === "yue").length} Cantonese`
  );

  console.log("\n→ [generateAudio]");
  const audioBuffer = await generateAudio(segments);
  console.log("✓ [generateAudio] done");

  console.log("\n→ [uploadMp3]");
  const audioUrl = await uploadMp3(audioBuffer, date, {
    cacheControl: "public, max-age=0, must-revalidate",
  });
  console.log("✓ [uploadMp3] done");

  console.log("\n→ [buildUpdatedFeed]");
  const feedXml = await buildUpdatedFeed(existingFeed, {
    date,
    audioUrl,
    audioBuffer,
    audioSize: audioBuffer.length,
    summary: preservedSummary ?? summary,
  });
  console.log("✓ [buildUpdatedFeed] done");

  console.log("\n→ [uploadFeed]");
  const feedUrl = await uploadFeed(feedXml);
  console.log("✓ [uploadFeed] done");

  console.log(`\n====== Republish complete ======`);
  console.log(`Episode: ${audioUrl}`);
  console.log(`Feed:    ${feedUrl}`);
  console.log("[republish] SQLite unchanged — articles not re-blacklisted");
}

main().catch((err) => {
  console.error("\nRepublish FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
