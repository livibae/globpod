/**
 * Generate script + audio locally for listening — no R2 upload, no feed update.
 *
 * Usage: npx tsx scripts/preview-audio.mts [YYYY-MM-DD]
 */
import "dotenv/config";
import { writeFile } from "fs/promises";
import { getUsedArticlesForDate } from "../src/db/sqlite.js";
import type { Article, GroupedArticles } from "../src/pipeline/fetchArticles.js";
import { fetchArticles } from "../src/pipeline/fetchArticles.js";
import { generateScript } from "../src/pipeline/generateScript.js";
import { generateAudio } from "../src/pipeline/generateAudio.js";

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);

function filterToUsedIds(
  grouped: GroupedArticles,
  usedIds: Set<string>
): GroupedArticles {
  const pick = (list: Article[]) => list.filter((a) => usedIds.has(a.id));
  return { hk: pick(grouped.hk), uk: pick(grouped.uk), nl: pick(grouped.nl) };
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

const usedRows = getUsedArticlesForDate(date);
if (usedRows.length === 0) {
  throw new Error(`No used articles in SQLite for ${date}`);
}

const usedIds = new Set(usedRows.map((r) => r.id));
const fetched = await fetchArticles({ includeUsed: true, maxAgeHours: 48 });
let articles = filterToUsedIds(fetched, usedIds);

for (const row of usedRows) {
  const found = [...articles.hk, ...articles.uk, ...articles.nl].some(
    (a) => a.id === row.id
  );
  if (!found) {
    const stub = articleFromRecord(row);
    articles[stub.region].push(stub);
  }
}

console.log(`\n=== Preview audio for ${date} (local only, not published) ===\n`);

const { script, segments, summary } = await generateScript(articles);
const audioBuffer = await generateAudio(segments);

const mp3Path = `preview-episode-${date}.mp3`;
const scriptPath = `preview-episode-${date}-script.txt`;

await writeFile(mp3Path, audioBuffer);
await writeFile(
  scriptPath,
  [
    `=== SUMMARY ===`,
    summary,
    "",
    `=== SEGMENTS (${segments.length}) ===`,
    ...segments.map((s, i) => `--- ${i + 1}. ${s.lang} ---\n${s.text}\n`),
    `=== FULL SCRIPT ===`,
    script,
  ].join("\n")
);

const sizeMb = (audioBuffer.length / (1024 * 1024)).toFixed(1);
console.log(`\nDone — ${sizeMb} MB`);
console.log(`Listen:  ${mp3Path}`);
console.log(`Script:  ${scriptPath}`);
console.log(`(Not uploaded to R2 — safe to listen before republishing)`);
