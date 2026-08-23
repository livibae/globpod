/**
 * One-off: upload a minimal HTML homepage to R2 at globpod/index.html.
 *
 * Podcast feed validators require the channel <link> to point to an HTML page
 * (Content-Type: text/html). R2's bucket root returns 404, and the feed URL
 * itself returns application/rss+xml, so we host a tiny landing page.
 *
 * Run with: npx tsx src/uploadHomepage.ts
 */

import "dotenv/config";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GlobPod</title>
  <meta name="description" content="Personal AI-powered daily news podcast covering Hong Kong, UK, and Netherlands.">
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; line-height: 1.5; color: #222; }
    h1 { font-size: 2rem; }
    p { color: #555; }
  </style>
</head>
<body>
  <h1>GlobPod</h1>
  <p>A personal AI-powered daily news podcast covering Hong Kong, the United Kingdom, and the Netherlands.</p>
  <p>Subscribe via your favorite podcast app using the private RSS feed URL.</p>
</body>
</html>
`;

async function main(): Promise<void> {
  const endpoint = process.env.CF_R2_ENDPOINT;
  const accessKeyId = process.env.CF_R2_ACCESS_KEY;
  const secretAccessKey = process.env.CF_R2_SECRET_KEY;
  const bucket = process.env.CF_R2_BUCKET_NAME;
  const publicUrl = process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, "");

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
    throw new Error("Missing required R2 env vars");
  }

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  console.log("[homepage] Uploading index.html…");
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "index.html",
      Body: Buffer.from(HTML, "utf-8"),
      ContentType: "text/html; charset=utf-8",
      CacheControl: "public, max-age=3600",
    })
  );

  console.log(`[homepage] Done → ${publicUrl}/index.html`);
}

main().catch((err) => {
  console.error("[homepage] FAILED:", err.message);
  process.exit(1);
});
