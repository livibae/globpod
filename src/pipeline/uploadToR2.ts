/**
 * Cloudflare R2 storage operations for GlobPod.
 *
 * R2 is S3-compatible, so we use the AWS SDK v3 S3 client.
 * Handles:
 * - Uploading the daily MP3 episode
 * - Fetching the existing RSS XML feed (returns null on first run)
 * - Uploading the updated RSS XML feed
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";

// ---------------------------------------------------------------------------
// R2 client (lazy singleton)
// ---------------------------------------------------------------------------

let client: S3Client | null = null;

function getClient(): S3Client {
  if (client) return client;

  const endpoint = process.env.CF_R2_ENDPOINT;
  const accessKeyId = process.env.CF_R2_ACCESS_KEY;
  const secretAccessKey = process.env.CF_R2_SECRET_KEY;

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing required R2 env vars: CF_R2_ENDPOINT, CF_R2_ACCESS_KEY, CF_R2_SECRET_KEY"
    );
  }

  client = new S3Client({
    region: "auto", // R2 uses "auto" region
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  return client;
}

function getBucketName(): string {
  const bucket = process.env.CF_R2_BUCKET_NAME;
  if (!bucket) throw new Error("Missing required env var: CF_R2_BUCKET_NAME");
  return bucket;
}

function getPublicUrl(): string {
  const url = process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, ""); // strip trailing slash
  if (!url) throw new Error("Missing required env var: CF_R2_PUBLIC_URL");
  return url;
}

function getFeedToken(): string {
  const token = process.env.FEED_SECRET_TOKEN;
  if (!token) throw new Error("Missing required env var: FEED_SECRET_TOKEN");
  return token;
}

// ---------------------------------------------------------------------------
// MP3 upload
// ---------------------------------------------------------------------------

/**
 * Upload the daily MP3 episode to R2.
 * @param buffer - The MP3 audio Buffer from ElevenLabs
 * @param date  - The episode date (YYYY-MM-DD), used as the filename
 * @returns The public HTTPS URL for the uploaded MP3
 */
export async function uploadMp3(buffer: Buffer, date: string): Promise<string> {
  const key = `episodes/${date}.mp3`;

  console.log(`[r2] Uploading MP3 → ${key}`);

  await getClient().send(
    new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: buffer,
      ContentType: "audio/mpeg",
      // Cache for 1 year — episode audio never changes after upload
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const publicUrl = `${getPublicUrl()}/${key}`;
  console.log(`[r2] MP3 uploaded → ${publicUrl}`);
  return publicUrl;
}

// ---------------------------------------------------------------------------
// RSS feed fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the current RSS XML from R2.
 * Returns null on first run (when the feed doesn't exist yet).
 */
export async function fetchExistingFeed(): Promise<string | null> {
  const key = `feed/${getFeedToken()}.xml`;

  console.log(`[r2] Fetching existing feed → ${key}`);

  try {
    const response = await getClient().send(
      new GetObjectCommand({
        Bucket: getBucketName(),
        Key: key,
      })
    );

    // Convert the response stream to a string
    const body = response.Body;
    if (!body) return null;

    const chunks: Uint8Array[] = [];
    for await (const chunk of body as Readable) {
      chunks.push(chunk as Uint8Array);
    }

    const xml = Buffer.concat(chunks).toString("utf-8");
    console.log("[r2] Existing feed fetched successfully");
    return xml;
  } catch (err) {
    // NoSuchKey = first run, no feed exists yet — that's expected
    if (err instanceof NoSuchKey) {
      console.log("[r2] No existing feed found — will create skeleton on first run");
      return null;
    }
    throw err; // re-throw unexpected errors
  }
}

// ---------------------------------------------------------------------------
// RSS feed upload
// ---------------------------------------------------------------------------

/**
 * Upload the updated RSS XML to R2 at the private feed path.
 * Overwrites the existing file in place.
 */
export async function uploadFeed(xml: string): Promise<string> {
  const key = `feed/${getFeedToken()}.xml`;

  console.log(`[r2] Uploading updated feed → ${key}`);

  await getClient().send(
    new PutObjectCommand({
      Bucket: getBucketName(),
      Key: key,
      Body: Buffer.from(xml, "utf-8"),
      ContentType: "application/rss+xml; charset=utf-8",
      // No long-term caching — podcast apps should check for updates daily
      CacheControl: "no-cache",
    })
  );

  const feedUrl = `${getPublicUrl()}/${key}`;
  console.log(`[r2] Feed uploaded → ${feedUrl}`);
  return feedUrl;
}
