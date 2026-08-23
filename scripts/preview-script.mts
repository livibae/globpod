/**
 * Preview script generation without TTS/upload (debug prompt output).
 * Usage: npx tsx scripts/preview-script.mts
 */
import "dotenv/config";
import { writeFile } from "fs/promises";
import { getUsedArticlesForDate } from "../src/db/sqlite.js";
import type { Article, GroupedArticles } from "../src/pipeline/fetchArticles.js";
import { fetchArticles } from "../src/pipeline/fetchArticles.js";
import { generateScript } from "../src/pipeline/generateScript.js";

const date = process.argv[2] ?? "2026-08-23";

function filterToUsedIds(
  grouped: GroupedArticles,
  usedIds: Set<string>
): GroupedArticles {
  const pick = (list: Article[]) => list.filter((a) => usedIds.has(a.id));
  return { hk: pick(grouped.hk), uk: pick(grouped.uk), nl: pick(grouped.nl) };
}

const usedRows = getUsedArticlesForDate(date);
const usedIds = new Set(usedRows.map((r) => r.id));
const fetched = await fetchArticles({ includeUsed: true, maxAgeHours: 48 });
const articles = filterToUsedIds(fetched, usedIds);

console.log(`Generating script preview for ${date} (${usedIds.size} stories)…`);
const { script, segments, summary, usedFallback } = await generateScript(articles);

const out = `scripts/preview-${date}.txt`;
const body = [
  `=== SUMMARY ===`,
  summary,
  "",
  `=== SEGMENTS (${segments.length}) ===`,
  ...segments.map((s, i) => `--- ${i + 1}. ${s.lang} ---\n${s.text}\n`),
  `=== FULL SCRIPT ===`,
  script,
  "",
  `usedFallback=${usedFallback}`,
].join("\n");

await writeFile(out, body);
console.log(`Written ${out}`);
