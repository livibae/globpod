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

// Maximum number of episodes kept in the feed
const MAX_EPISODES = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpisodeInput {
  date: string;       // YYYY-MM-DD
  audioUrl: string;   // public MP3 URL
  audioBuffer: Buffer; // MP3 bytes — used to parse real duration
  audioSize: number;  // byte length of the MP3
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

// ---------------------------------------------------------------------------
// XML parser + builder (configured for podcast RSS 2.0)
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  isArray: (name) => name === "item", // always treat <item> as an array
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

// Cover art URL — required by podcast apps (Overcast, Apple Podcasts).
// placehold.co serves a direct JPG with no redirects (picsum redirects, which Overcast rejects).
// Replace with a self-hosted 1400×1400 image on R2 when ready.
const COVER_ART_URL = "https://placehold.co/1400x1400/0066CC/FFFFFF.jpg?text=GlobPod";

/**
 * Build the channel skeleton for the feed.
 * Always rebuilt fresh on each run so metadata edits propagate to the live feed.
 */
function buildBlankFeed(): string {
  // Channel link must resolve to an HTML page (text/html).
  // We host a minimal index.html in R2 — see src/uploadHomepage.ts.
  const baseUrl = process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, "");
  const feedToken = process.env.FEED_SECRET_TOKEN;
  const homepageUrl = baseUrl ? `${baseUrl}/index.html` : "https://example.com";
  const feedUrl =
    baseUrl && feedToken ? `${baseUrl}/feed/${feedToken}.xml` : homepageUrl;

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>GlobPod</title>
    <link>${homepageUrl}</link>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <description>Your personal AI-powered daily news podcast covering Hong Kong, UK, and Netherlands.</description>
    <language>en</language>
    <itunes:author>GlobPod</itunes:author>
    <itunes:type>episodic</itunes:type>
    <itunes:image href="${COVER_ART_URL}"/>
    <itunes:owner>
      <itunes:name>GlobPod</itunes:name>
      <itunes:email>noreply@globpod.local</itunes:email>
    </itunes:owner>
    <itunes:explicit>false</itunes:explicit>
    <itunes:category text="News"/>
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
  durationSeconds: number
): Record<string, unknown> {
  // Episode link must be HTML — we don't host per-episode pages, so reuse the homepage.
  const baseUrl = process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, "");
  const link = baseUrl ? `${baseUrl}/index.html` : "https://example.com";

  return {
    title: `GlobPod — ${date}`,
    link,
    pubDate: new Date(`${date}T06:00:00`).toUTCString(),
    guid: { "#text": audioUrl, "@_isPermaLink": "false" },
    enclosure: {
      "@_url": audioUrl,
      "@_length": String(audioSize),
      "@_type": "audio/mpeg",
    },
    "itunes:duration": formatDuration(durationSeconds),
    "itunes:explicit": "false",
  };
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
    durationSeconds
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
