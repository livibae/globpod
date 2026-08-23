/**
 * Podcast channel / episode metadata for GlobPod.
 *
 * Kept out of updateFeed.ts so branding and feed fields can change without
 * digging through XML template strings. Env overrides let you point at a
 * real cover / owner email without a code change (LIV-11 / overlaps LIV-10).
 */

export interface PodcastConfig {
  title: string;
  author: string;
  ownerName: string;
  ownerEmail: string;
  description: string;
  summary: string;
  language: string;
  copyright: string;
  coverArtUrl: string;
  /** Apple Podcasts categories — first is primary. Max 3. */
  categories: Array<{ text: string; subcategory?: string }>;
  /** Episode pubDate time-of-day in UTC (HH:MM:SS). */
  episodePublishTimeUtc: string;
}

const YEAR = new Date().getFullYear();

/**
 * Resolve podcast config. Env vars override defaults where set.
 */
export function getPodcastConfig(): PodcastConfig {
  const ownerEmail =
    process.env.PODCAST_OWNER_EMAIL?.trim() ||
    process.env.NOTIFY_EMAIL?.trim() ||
    "noreply@globpod.local";

  const coverArtUrl =
    process.env.PODCAST_COVER_URL?.trim() ||
    "https://placehold.co/1400x1400/0066CC/FFFFFF.jpg?text=GlobPod";

  return {
    title: "GlobPod",
    author: "Livia Yeung",
    ownerName: "Livia Yeung",
    ownerEmail,
    description:
      "A personal AI-powered daily news podcast covering Hong Kong, the United Kingdom, and the Netherlands.",
    summary:
      "Private morning briefing for one listener: Hong Kong news in Cantonese, UK and Netherlands in English. Curated from local RSS feeds, written by Claude, spoken by ElevenLabs.",
    language: "en",
    copyright: `©${YEAR} Livia Yeung`,
    coverArtUrl,
    categories: [
      { text: "News", subcategory: "Daily News" },
      { text: "News", subcategory: "Politics" },
      { text: "Society & Culture" },
    ],
    episodePublishTimeUtc: "06:00:00",
  };
}
