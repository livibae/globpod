/**
 * RSS ingestion + deduplication for GlobPod.
 *
 * Fetches all 6 curated feeds, filters to the last 24 hours, skips articles
 * already used in a published episode (SQLite), and returns articles grouped
 * by region ready for script generation.
 *
 * Does NOT write to SQLite. Blacklisting happens after a successful publish
 * via markArticlesUsed() (LIV-8).
 */

import Parser from "rss-parser";
import { hasArticle } from "../db/sqlite.js";

// ---------------------------------------------------------------------------
// Feed definitions
// ---------------------------------------------------------------------------

type Region = "hk" | "uk" | "nl";

interface FeedSource {
  name: string;
  url: string;
  region: Region;
}

const FEEDS: FeedSource[] = [
  // Hong Kong
  // /rss/2/ is SCMP's "Hong Kong" section. /rss/91/ is "News" — a pan-Asia
  // wire that mostly surfaces Singapore/Beijing stories, not HK ones.
  { name: "SCMP", url: "https://www.scmp.com/rss/2/feed", region: "hk" },
  { name: "Hong Kong Free Press", url: "https://hongkongfp.com/feed/", region: "hk" },
  // United Kingdom
  { name: "BBC News", url: "http://feeds.bbci.co.uk/news/rss.xml", region: "uk" },
  { name: "The Guardian", url: "https://www.theguardian.com/uk/rss", region: "uk" },
  // Netherlands
  { name: "DutchNews.nl", url: "https://www.dutchnews.nl/feed/", region: "nl" },
  { name: "NL Times", url: "https://nltimes.nl/rss.xml", region: "nl" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Article {
  id: string; // namespaced dedup key: `${feedName}:${guid|link}`
  title: string;
  link: string;
  summary: string; // content snippet or description
  region: Region;
  feedName: string;
  pubDate: Date;
}

export interface GroupedArticles {
  hk: Article[];
  uk: Article[];
  nl: Article[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const parser = new Parser({
  timeout: 10_000, // 10s per feed — fail fast rather than stall the pipeline
});

/**
 * Namespace a raw RSS guid/link under its feed name.
 * Prevents bare-integer guids (e.g. NL Times "91190") colliding across feeds.
 */
export function articleId(feedName: string, rawId: string): string {
  return `${feedName}:${rawId}`;
}

/**
 * Parse an RSS date string, tolerating formats `new Date()` rejects.
 *
 * NL Times emits "23 August 2026 - 12:45" (no timezone, " - " between date
 * and time), which is not RFC-822 and parses as Invalid Date. Stripping the
 * separator makes it parseable.
 *
 * Note: dates without a timezone resolve in the *process* timezone. Correct
 * on a Europe/Amsterdam machine; pin TZ when this moves to a server (LIV-7).
 *
 * @returns A valid Date, or null if the string can't be parsed at all.
 */
function parseFeedDate(raw: string): Date | null {
  const direct = new Date(raw);
  if (!isNaN(direct.getTime())) return direct;

  const relaxed = new Date(raw.replace(/\s+-\s+/, " "));
  if (!isNaN(relaxed.getTime())) return relaxed;

  return null;
}

/** Filter threshold: articles must be published within the last 24 hours. */
function isRecent(pubDate: Date): boolean {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return pubDate > cutoff;
}

/**
 * Fetch and parse a single RSS feed.
 * Returns an empty array on error so one bad feed doesn't kill the pipeline.
 */
async function fetchFeed(source: FeedSource): Promise<Article[]> {
  try {
    const feed = await parser.parseURL(source.url);
    const articles: Article[] = [];

    // Track why items were dropped, so a silently-empty feed is diagnosable
    const skipped = { noKey: 0, noDate: 0, badDate: 0, old: 0, seen: 0 };

    for (const item of feed.items) {
      // Deduplication key: prefer guid, fall back to link — then namespace
      const rawId = item.guid ?? item.link;
      if (!rawId) {
        skipped.noKey++;
        continue; // skip items with no identifiable key
      }
      const id = articleId(source.name, rawId);

      // Parse publish date; prefer isoDate (rss-parser's normalised field)
      const rawDate = item.isoDate ?? item.pubDate;
      if (!rawDate) {
        skipped.noDate++;
        continue;
      }
      const pubDate = parseFeedDate(rawDate);
      if (!pubDate) {
        skipped.badDate++;
        continue;
      }

      // Only include articles from the last 24 hours
      if (!isRecent(pubDate)) {
        skipped.old++;
        continue;
      }

      // Skip if already used in a published episode
      if (hasArticle(id)) {
        skipped.seen++;
        continue;
      }

      articles.push({
        id,
        title: item.title ?? "(no title)",
        link: item.link ?? rawId,
        summary: item.contentSnippet ?? item.content ?? item.summary ?? "",
        region: source.region,
        feedName: source.name,
        pubDate,
      });
    }

    console.log(`  [fetch] ${source.name}: ${articles.length} new article(s)`);

    // A feed that returns items but yields nothing usable looks identical to a
    // quiet news day in the logs. Make that case loud — it's how the NL Times
    // date-format bug went unnoticed for months.
    if (articles.length === 0 && feed.items.length > 0) {
      console.warn(
        `  [fetch] WARN: ${source.name} returned ${feed.items.length} item(s) but 0 were usable ` +
          `(nokey=${skipped.noKey} nodate=${skipped.noDate} baddate=${skipped.badDate} ` +
          `old=${skipped.old} seen=${skipped.seen})`
      );
    }

    return articles;
  } catch (err) {
    // Log but don't throw — a single unavailable feed shouldn't abort the run
    console.warn(`  [fetch] WARN: failed to fetch ${source.name}: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all feeds, skip already-used articles, return grouped by region.
 * Read-only against SQLite — does not blacklist anything.
 */
export async function fetchArticles(): Promise<GroupedArticles> {
  // Fetch all feeds concurrently
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all = results.flat();

  // Group by region
  const grouped: GroupedArticles = { hk: [], uk: [], nl: [] };
  for (const article of all) {
    grouped[article.region].push(article);
  }

  const total = all.length;
  console.log(
    `[fetch] Done — ${total} new article(s): HK=${grouped.hk.length}, UK=${grouped.uk.length}, NL=${grouped.nl.length}`
  );

  return grouped;
}
