/**
 * One-off: upload podcast cover art to R2 at cover.jpg.
 *
 * Expects a local JPG at assets/cover.jpg (preferably 3000×3000).
 * After upload, set PODCAST_COVER_URL in .env and run:
 *   npx tsx src/regenFeed.ts
 *
 * Run with: npx tsx src/uploadCover.ts
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COVER_PATH = path.resolve(__dirname, "../assets/cover.jpg");

async function main(): Promise<void> {
  const endpoint = process.env.CF_R2_ENDPOINT;
  const accessKeyId = process.env.CF_R2_ACCESS_KEY;
  const secretAccessKey = process.env.CF_R2_SECRET_KEY;
  const bucket = process.env.CF_R2_BUCKET_NAME;
  const publicUrl = process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, "");

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    throw new Error("Missing required R2 env vars");
  }
  if (!existsSync(COVER_PATH)) {
    throw new Error(`Missing cover file at ${COVER_PATH}`);
  }

  const body = readFileSync(COVER_PATH);
  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  console.log(`[cover] Uploading assets/cover.jpg (${body.length} bytes)…`);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "cover.jpg",
      Body: body,
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=86400",
    })
  );

  const url = `${publicUrl}/cover.jpg`;
  console.log(`[cover] Done → ${url}`);
  console.log(`[cover] Set PODCAST_COVER_URL=${url} then run: npx tsx src/regenFeed.ts`);
}

main().catch((err) => {
  console.error("[cover] FAILED:", err.message);
  process.exit(1);
});
