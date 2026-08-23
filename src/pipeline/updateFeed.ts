/**
 * RSS feed construction and update for GlobPod.
 *
 * Takes the existing feed XML (or null on first run), parses it,
 * prepends a new episode entry, caps history at 10 episodes,
 * and returns a valid podcast RSS 2.0 XML string.
 *
 * Compatible with: Overcast, Apple Podcasts, Pocket Casts.
 */

import { parseBuffer } from "music-metadata";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { getPodcastConfig } from "../config/podcast.js";

// Maximum number of episodes kept in the feed
const MAX_EPISODES = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpisodeInput {
  date: string; // YYYY-MM-DD
  audioUrl: string; // public MP3 URL
  audioBuffer: Buffer; // MP3 bytes — used to parse real duration
  audioSize: number; // byte length of the MP3
  /** 2–3 sentence episode blurb for podcast apps (optional). */
  summary?: string;
}

interface ParsedChannel {
  item?: Record<string, unknown> | Record<string, unknown>[];
  [key: string]: unknown;
}

interface ParsedFeed {
  rss: {
    channel: ParsedChannel;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

/**
 * Parse the actual duration (in seconds) from an MP3 Buffer using music-metadata.
 * This gives an accurate duration rather than an estimate.
 */
async function parseDurationSeconds(buffer: Buffer): Promise<number> {
  const metadata = await parseBuffer(buffer, { mimeType: "audio/mpeg" });
  const duration = metadata.format.duration;
  if (!duration) throw new Error("Could not parse duration from MP3 buffer");
  return Math.round(duration);
}

/** Format duration as HH:MM:SS for the iTunes <itunes:duration> tag. */
function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// XML parser + builder (configured for podcast RSS 2.0)
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  isArray: (name) => name === "item" || name === "itunes:category",
});

const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true, // <enclosure .../> not <enclosure></enclosure>
});

// ---------------------------------------------------------------------------
// RSS feed helpers
// ---------------------------------------------------------------------------

/**
 * Build the channel skeleton for the feed.
 * Always rebuilt fresh on each run so metadata edits propagate to the live feed.
 */
function buildBlankFeed(): string {
  const podcast = getPodcastConfig();

  // Channel link must resolve to an HTML page (text/html).
  // We host a minimal index.html in R2 — see src/uploadHomepage.ts.
  const baseUrl = process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, "");
  const feedToken = process.env.FEED_SECRET_TOKEN;
  const homepageUrl = baseUrl ? `${baseUrl}/index.html` : "https://example.com";
  const feedUrl =
    baseUrl && feedToken ? `${baseUrl}/feed/${feedToken}.xml` : homepageUrl;

  const categoryXml = podcast.categories
    .map((cat) => {
      if (cat.subcategory) {
        return `    <itunes:category text="${escapeXml(cat.text)}">
      <itunes:category text="${escapeXml(cat.subcategory)}"/>
    </itunes:category>`;
      }
      return `    <itunes:category text="${escapeXml(cat.text)}"/>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(podcast.title)}</title>
    <link>${homepageUrl}</link>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <description>${escapeXml(podcast.description)}</description>
    <itunes:summary>${escapeXml(podcast.summary)}</itunes:summary>
    <copyright>${escapeXml(podcast.copyright)}</copyright>
    <language>${escapeXml(podcast.language)}</language>
    <itunes:author>${escapeXml(podcast.author)}</itunes:author>
    <itunes:type>episodic</itunes:type>
    <itunes:image href="${escapeXml(podcast.coverArtUrl)}"/>
    <itunes:owner>
      <itunes:name>${escapeXml(podcast.ownerName)}</itunes:name>
      <itunes:email>${escapeXml(podcast.ownerEmail)}</itunes:email>
    </itunes:owner>
    <itunes:explicit>false</itunes:explicit>
${categoryXml}
  </channel>
</rss>`;
}

/**
 * Build a structured episode object for insertion into the parsed feed.
 * XMLBuilder handles XML entity encoding automatically.
 */
function buildEpisodeObject(
  date: string,
  audioUrl: string,
  audioSize: number,
  durationSeconds: number,
  summary?: string
): Record<string, unknown> {
  const podcast = getPodcastConfig();

  // Episode link must be HTML — we don't host per-episode pages, so reuse the homepage.
  const baseUrl = process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, "");
  const link = baseUrl ? `${baseUrl}/index.html` : "https://example.com";

  // Explicit Z so pubDate is always 06:00 UTC regardless of host timezone (LIV-11).
  const pubDate = new Date(
    `${date}T${podcast.episodePublishTimeUtc}Z`
  ).toUTCString();

  const episode: Record<string, unknown> = {
    title: `${podcast.title} — ${date}`,
    link,
    pubDate,
    guid: { "#text": audioUrl, "@_isPermaLink": "false" },
    enclosure: {
      "@_url": audioUrl,
      "@_length": String(audioSize),
      "@_type": "audio/mpeg",
    },
    "itunes:author": podcast.author,
    "itunes:duration": formatDuration(durationSeconds),
    "itunes:explicit": "false",
  };

  if (summary && summary.trim()) {
    const blurb = summary.trim();
    episode.description = blurb;
    episode["itunes:summary"] = blurb;
  }

  return episode;
}

/**
 * Parse existing feed XML into a structured object.
 * Throws a descriptive error if malformed — the pipeline will then
 * send an error email rather than silently losing feed history.
 */
function parseFeed(feedXml: string): ParsedFeed {
  try {
    return xmlParser.parse(feedXml) as ParsedFeed;
  } catch (err) {
    throw new Error(
      `Failed to parse existing feed XML — feed may be corrupted: ${(err as Error).message}`
    );
  }
}

/**
 * Extract existing episode items from a parsed feed.
 * Returns an empty array for a blank feed with no episodes.
 */
function getExistingItems(feed: ParsedFeed): Record<string, unknown>[] {
  const items = feed.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rebuild the feed XML with a fresh channel skeleton while preserving existing
 * episode items. Used to apply metadata changes without regenerating audio.
 */
export function rebuildFeedMetadata(existingXml: string): string {
  const feed = parseFeed(buildBlankFeed());
  const existingItems = getExistingItems(parseFeed(existingXml));

  // Backfill the <link> field on items that pre-date this requirement.
  const baseUrl = process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, "");
  const homepageLink = baseUrl ? `${baseUrl}/index.html` : "https://example.com";
  const patchedItems = existingItems.map((item) =>
    item.link ? item : { ...item, link: homepageLink }
  );

  feed.rss.channel.item = patchedItems.slice(0, MAX_EPISODES);

  let xml = xmlBuilder.build(feed) as string;
  if (!xml.startsWith("<?xml")) {
    xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  }
  return xml;
}

/**
 * Build an updated RSS XML string by prepending a new episode to the existing feed.
 *
 * @param existingXml - Current feed XML from R2, or null on first run
 * @param episode     - Metadata and audio buffer for the new episode
 * @returns Updated podcast RSS 2.0 XML string
 */
export async function buildUpdatedFeed(
  existingXml: string | null,
  episode: EpisodeInput
): Promise<string> {
  // Parse real duration from MP3 bytes
  const durationSeconds = await parseDurationSeconds(episode.audioBuffer);
  console.log(
    `[feed] Episode duration: ${formatDuration(durationSeconds)} (${durationSeconds}s)`
  );

  // Always rebuild from the fresh skeleton so channel metadata stays current.
  // Existing items are carried over from the previous feed (if any).
  const feed = parseFeed(buildBlankFeed());
  const existingItems = existingXml ? getExistingItems(parseFeed(existingXml)) : [];

  // Build new episode as structured object
  const newEpisode = buildEpisodeObject(
    episode.date,
    episode.audioUrl,
    episode.audioSize,
    durationSeconds,
    episode.summary
  );

  // Prepend the new episode, dedup by guid (so re-runs on the same day don't duplicate),
  // then cap at MAX_EPISODES.
  const combined = [newEpisode, ...existingItems];
  const seen = new Set<string>();
  const deduped = combined.filter((item) => {
    const rawGuid = item.guid;
    const guid =
      typeof rawGuid === "object" && rawGuid !== null
        ? (rawGuid as { "#text"?: string })["#text"]
        : (rawGuid as string | undefined);
    if (!guid || seen.has(guid)) return false;
    seen.add(guid);
    return true;
  });
  feed.rss.channel.item = deduped.slice(0, MAX_EPISODES);

  // Serialize back to XML
  let xml = xmlBuilder.build(feed) as string;
  if (!xml.startsWith("<?xml")) {
    xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  }

  const itemCount = (feed.rss.channel.item as Record<string, unknown>[]).length;
  console.log(
    `[feed] Feed updated — ${itemCount} episode(s) total (max ${MAX_EPISODES})`
  );

  return xml;
}
