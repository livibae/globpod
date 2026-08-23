/**
 * Podcast script generation via Anthropic Claude API.
 *
 * Takes grouped articles (HK / UK / NL) and returns a 10–15 minute script
 * plus the IDs of articles actually used in it (LIV-8).
 *
 * The Hong Kong section is written in colloquial Cantonese (廣東話); every
 * other section is English. One paragraph per story, three stories per
 * region. See LIV-9 for the rationale.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Article, GroupedArticles } from "./fetchArticles.js";
import { withRetry } from "../util/retry.js";
import type { AudioSegment } from "./generateAudio.js";
import { inferSegmentsFromScript } from "./generateAudio.js";
import { containsSpeechArtifacts, sanitizeForSpeech } from "./sanitizeSpeech.js";

type Region = Article["region"];

const MODEL = "claude-sonnet-5";

// Generous ceiling, not a target. Sonnet 5 runs adaptive thinking by default,
// and thinking tokens count toward this budget — 2048 risks truncation.
const MAX_TOKENS = 16000;

// Stories selected per region. The model sees more candidates than this and
// picks the best ones — see CANDIDATES_PER_REGION.
const STORIES_PER_REGION = 3;

// How many articles per region Claude gets to choose from.
export const CANDIDATES_PER_REGION = 8;

// Source summary characters passed per article. More grounding material means
// less temptation to invent detail when writing a long paragraph.
const SUMMARY_CHARS = 600;

export interface ScriptResult {
  script: string;
  /** Language-tagged blocks for TTS (Cantonese vs English). */
  segments: AudioSegment[];
  /** Article IDs to blacklist after a successful publish. */
  usedArticleIds: string[];
  /** True when usedArticleIds fell back to all candidates shown to Claude. */
  usedFallback: boolean;
  /** 2–3 sentence English episode blurb for podcast apps. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Standing instructions: who the listener is, what voice to use, and the
 * rules that don't change day to day. Kept separate from the daily article
 * payload so the two can be reasoned about independently.
 */
const SYSTEM_PROMPT = `You are the writer and host of a private daily news podcast made for exactly one listener. You are not a wire service and not a broadcast anchor. You are closer to a well-read friend who goes through the morning's news and tells her what actually matters.

WHO YOU ARE TALKING TO

She was born and raised in Hong Kong. At sixteen she left for the United Kingdom, where she studied and then worked until she was twenty-five. Since August 2025 she has lived in Amsterdam, working in the Netherlands as an expat.

All three places are hers, but they are hers in different ways: Hong Kong is home and family, the UK is where she grew up and built an adult life, the Netherlands is where she lives now and is still figuring out. Let that difference show in how you cover each region. Reach for it only when a story genuinely invites it — an unforced "back home", "when I was living in the UK", "here in Amsterdam" lands well; a forced one is worse than none at all. Do not do it in every section.

LANGUAGE

- Greeting and sign-off: English.
- Hong Kong section: written Cantonese (廣東話). Colloquial spoken Cantonese as Hongkongers actually speak it — NOT 書面語 or standard written Chinese. Use 係 rather than 是, 唔 rather than 不, 嘅 rather than 的, 咗 for completed actions, 佢 rather than 他/她. It will be read aloud, so write it to be spoken.
- United Kingdom and Netherlands sections: English.
- Switch between languages without remarking on it. Never translate, gloss, or explain the Cantonese.

TONE

Match the tone to the weight of the story. A death, an assault, a corruption case: slow down, stay plain, do not editorialise. Politics and policy: measured and clear. Sport, culture, civic absurdity: warmth and dryness are welcome. The register should genuinely move across a single episode. Never sound bright about something grim.

GROUNDING

Work only from the source material provided. If a detail is not in the source, do not state it. Where a source is thin, give that story less time rather than inventing texture — a short honest paragraph is better than a padded one. You may add general context you are confident is true (what an institution does, where a place is, what an ongoing scheme or earlier event was about), but never invent specifics: no fabricated numbers, quotes, dates, names, or causes.

Follow-ups need backstory. If today's item only makes sense if you already know the earlier chapter — an update, deadline, government response, court ruling, second vote — start with one sentence that re-establishes what the original story was, then deliver today's development. She may have missed earlier coverage.

SCRIPT FORMAT

The podcast script itself must be spoken prose only. No markdown, no headers, no bullet points, no section labels, no stage directions, no speaker names. Never write words like "Intro", "Outro", or "Hong Kong section" — nothing that is not meant to be said out loud. Never include URLs, web addresses, story_id codes (hk-1, uk-2), or the word "http" anywhere in segments — those exist only in used_ids. Paragraph breaks are the only structure you have.

RESPONSE FORMAT

Respond with a single JSON object only — no markdown fences, no commentary before or after:
{
  "used_ids": ["id1", "id2", "..."],
  "summary": "<2-3 sentence English blurb for podcast apps>",
  "segments": [
    { "lang": "en", "text": "<greeting>" },
    { "lang": "yue", "text": "<Hong Kong section — all Cantonese paragraphs>" },
    { "lang": "en", "text": "<United Kingdom section>" },
    { "lang": "en", "text": "<Netherlands section>" },
    { "lang": "en", "text": "<sign-off>" }
  ]
}

segments is required for text-to-speech: lang must be "en" or "yue" (Cantonese). One segment per major block above — do not mix languages inside a segment.
used_ids must list story_id codes only (e.g. hk-1, uk-2, nl-3) for every story you covered — copied exactly from the candidate list. Never put URLs in used_ids or segments.
summary must be plain English (even when the HK section is Cantonese), suitable as an episode description in Overcast/Apple Podcasts — no spoilers beyond the headlines, no markdown.`;

/**
 * Articles Claude will actually see for a region (capped).
 */
export function candidatesForRegion(articles: Article[]): Article[] {
  return articles.slice(0, CANDIDATES_PER_REGION);
}

/**
 * Flat list of every candidate shown to Claude across regions.
 * Used as the blacklist fallback when structured used_ids can't be parsed.
 */
export function allCandidates(articles: GroupedArticles): Article[] {
  return [
    ...candidatesForRegion(articles.hk),
    ...candidatesForRegion(articles.uk),
    ...candidatesForRegion(articles.nl),
  ];
}

/**
 * Map short story_id codes (hk-1) to full dedup keys for SQLite.
 */
export function buildStoryIdMap(articles: GroupedArticles): Map<string, string> {
  const map = new Map<string, string>();
  for (const region of ["hk", "uk", "nl"] as Region[]) {
    candidatesForRegion(articles[region]).forEach((a, i) => {
      map.set(`${region}-${i + 1}`, a.id);
    });
  }
  return map;
}

/**
 * Format a region's candidate articles as a readable block for the prompt.
 */
function formatArticles(
  articles: Article[],
  regionLabel: string,
  regionCode: Region
): string {
  const candidates = candidatesForRegion(articles);
  if (candidates.length === 0) {
    return `### ${regionLabel}\n(No new articles in the last 24 hours)`;
  }

  const items = candidates
    .map(
      (a, i) =>
        `${i + 1}. story_id=${regionCode}-${i + 1}\n   ${a.title} (${a.feedName})\n   ${a.summary.slice(0, SUMMARY_CHARS)}`
    )
    .join("\n\n");

  return `### ${regionLabel}\n${items}`;
}

function buildPrompt(articles: GroupedArticles): string {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const hkBlock = formatArticles(articles.hk, "Hong Kong", "hk");
  const ukBlock = formatArticles(articles.uk, "United Kingdom", "uk");
  const nlBlock = formatArticles(articles.nl, "Netherlands", "nl");

  const hkMustCoverAll =
    articles.hk.length > 0 && articles.hk.length <= STORIES_PER_REGION;
  const ukMustCoverAll =
    articles.uk.length > 0 && articles.uk.length <= STORIES_PER_REGION;
  const nlMustCoverAll =
    articles.nl.length > 0 && articles.nl.length <= STORIES_PER_REGION;

  return `Write today's episode. Today is ${today}.

TARGET LENGTH: 10 to 15 minutes read aloud. Budget it roughly as:

- Greeting — about 30 seconds
- Hong Kong — about 3.5 minutes, in Cantonese (roughly 900–1,200 Chinese characters)
- United Kingdom — about 3.5 minutes (roughly 450–550 words)
- Netherlands — about 3.5 minutes (roughly 450–550 words)
- Sign-off — about 20 seconds

This is a real target, not a ceiling. The previous version of this podcast ran half the intended length because it covered too many stories too shallowly. Fewer stories, told properly, is the goal.

STRUCTURE

1. Greeting, in English. Vary how you open — do not use the same formula every day. "Good morning" is one option among many; you might open on the day itself, on a thread running through the news, or walk straight into the first story. Work the date in naturally. Do not name the podcast; she knows what she is listening to.
2. Hong Kong — exactly ${STORIES_PER_REGION} stories, in Cantonese.
3. United Kingdom — exactly ${STORIES_PER_REGION} stories, in English.
4. Netherlands — exactly ${STORIES_PER_REGION} stories, in English.
5. Sign-off, in English. Short, and varied day to day. Do not name the podcast here either.

HOW TO HANDLE EACH STORY

- Pick the ${STORIES_PER_REGION} most significant stories per region from the candidates below. Prefer stories that matter to someone who lives in or comes from that place over international stories that merely happened to appear in that region's feed. Related international news for a region is fine when it clearly connects to that place; pure wire filler is not.
${hkMustCoverAll ? `- Hong Kong lists exactly ${articles.hk.length} candidate(s) — cover every one.` : ""}
${ukMustCoverAll ? `- United Kingdom lists exactly ${articles.uk.length} candidate(s) — cover every one.` : ""}
${nlMustCoverAll ? `- Netherlands lists exactly ${articles.nl.length} candidate(s) — cover every one.` : ""}
- Give every story its OWN paragraph. Never chain two stories into one paragraph.
- Each story gets at least three or four sentences — at the length target above, that usually means six to ten. Say what happened, then who it affects and why it matters, then whatever context makes it land.
- If the day's news is a follow-up to an ongoing story — a deadline, a response, an update, a "no delay", a next hearing, a second vote — open with one plain sentence of backstory before the update. Assume she may have missed earlier chapters. Example shape: what the original event/scheme was, then today's development. Keep that backstory to one sentence, not a full history lesson.
- Do not bridge stories with connective filler. No "Meanwhile", "Elsewhere", "Turning to", "Moving on", "And on the economic front". Begin each paragraph on its own subject.
- If a region has fewer than ${STORIES_PER_REGION} genuinely usable stories, cover the ones that exist properly instead of padding to reach the number.

CANDIDATE ARTICLES

${hkBlock}

${ukBlock}

${nlBlock}

Return ONLY the JSON object described in your instructions: {"used_ids":[...],"summary":"...","segments":[...]}.
used_ids must list story_id codes only (hk-1, uk-2, nl-3, etc.) for every story covered.
summary must be 2–3 English sentences describing today's episode for podcast apps.
segments must follow the greeting → HK (yue) → UK (en) → NL (en) → sign-off (en) structure. The greeting segment is mandatory — open in English before any Hong Kong news.`;
}

function cleanSegmentText(text: string): string {
  return sanitizeForSpeech(text);
}

function normalizeSegments(segments: AudioSegment[]): AudioSegment[] {
  return segments
    .map((s) => ({ ...s, text: cleanSegmentText(s.text) }))
    .filter((s) => s.text.length > 0);
}

function validateSegments(segments: AudioSegment[]): void {
  if (segments.length < 3) {
    throw new Error(`expected at least 3 speech segments, got ${segments.length}`);
  }
  if (segments[0].lang !== "en") {
    throw new Error("first segment must be an English greeting");
  }
  if (segments[0].text.length < 30) {
    throw new Error("English greeting segment is too short");
  }
  for (const seg of segments) {
    if (containsSpeechArtifacts(seg.text)) {
      throw new Error(`segment contains URL or metadata: ${seg.text.slice(0, 80)}…`);
    }
  }
}

function parseSegments(raw: unknown, script: string): AudioSegment[] {
  if (!Array.isArray(raw)) {
    console.warn("[script] WARN: missing segments array — inferring from script paragraphs");
    return inferSegmentsFromScript(script);
  }

  const segments: AudioSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? cleanSegmentText(row.text.trim()) : "";
    if (!text) continue;
    const langRaw = row.lang;
    const lang: AudioSegment["lang"] =
      langRaw === "yue" || langRaw === "cantonese" || langRaw === "hk" ? "yue" : "en";
    segments.push({ lang, text });
  }

  if (segments.length === 0) {
    console.warn("[script] WARN: empty segments array — inferring from script paragraphs");
    return inferSegmentsFromScript(script);
  }

  const yue = segments.filter((s) => s.lang === "yue").length;
  if (yue === 0) {
    console.warn("[script] WARN: no yue segment in JSON — inferring Cantonese blocks from script");
    return inferSegmentsFromScript(script);
  }

  return segments;
}

function joinSegments(segments: AudioSegment[]): string {
  return segments.map((s) => s.text).join("\n\n");
}

// ---------------------------------------------------------------------------
// Response parsing (with fallback)
// ---------------------------------------------------------------------------

function resolveUsedIds(
  rawIds: string[],
  storyIdMap: Map<string, string>,
  candidateById: Map<string, Article>
): string[] {
  const resolved: string[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== "string") continue;
    const key = raw.trim();
    const id = storyIdMap.get(key) ?? (candidateById.has(key) ? key : null);
    if (id) resolved.push(id);
  }
  return [...new Set(resolved)];
}

/**
 * Extract a JSON object from a model response that may include fences or
 * surrounding prose. Returns null if nothing parseable is found.
 */
function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();

  // 1. Direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // 2. Fenced ```json ... ``` or ``` ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // continue
    }
  }

  // 3. First { to last }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Parse Claude's response into script + used ids.
 * Validates used_ids against the known candidate set.
 * On missing/invalid ids: keep the script, fall back to all candidate ids.
 */
function parseScriptResponse(
  raw: string,
  candidates: Article[],
  storyIdMap: Map<string, string>
): ScriptResult {
  const candidateById = new Map(candidates.map((a) => [a.id, a]));
  const fallbackIds = candidates.map((a) => a.id);
  const parsed = extractJsonObject(raw);

  const fallbackSummary = "";

  if (!parsed || typeof parsed !== "object") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.includes('"used_ids"')) {
      throw new Error("Claude response was JSON but could not be parsed");
    }
    const maybeScript = cleanSegmentText(trimmed);
    if (maybeScript.length < 200) {
      throw new Error("Claude response was not valid JSON and too short to treat as a script");
    }
    console.warn(
      "[script] WARN: could not parse JSON — blacklisting all candidates shown to Claude as fallback"
    );
    const segments = normalizeSegments(inferSegmentsFromScript(maybeScript));
    validateSegments(segments);
    return {
      script: maybeScript,
      segments,
      usedArticleIds: fallbackIds,
      usedFallback: true,
      summary: fallbackSummary,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" ? obj.summary.trim() :
    typeof obj.description === "string" ? obj.description.trim() :
    fallbackSummary;

  if (!summary) {
    console.warn("[script] WARN: missing episode summary in Claude response");
  }

  const scriptFromJson =
    typeof obj.script === "string" ? obj.script.trim() :
    typeof obj.text === "string" ? obj.text.trim() :
    "";

  const segments = normalizeSegments(parseSegments(obj.segments, scriptFromJson));
  const script = scriptFromJson || joinSegments(segments);

  if (script.length < 200) {
    throw new Error("Claude JSON response missing a usable script (too short)");
  }

  validateSegments(segments);

  const rawIds = Array.isArray(obj.used_ids)
    ? obj.used_ids
    : Array.isArray(obj.usedIds)
      ? obj.usedIds
      : null;

  const validIds =
    rawIds === null ? [] : resolveUsedIds(rawIds, storyIdMap, candidateById);

  if (validIds.length === 0) {
    console.warn(
      "[script] WARN: used_ids missing or invalid — blacklisting all candidates shown to Claude as fallback"
    );
    return {
      script,
      segments,
      usedArticleIds: fallbackIds,
      usedFallback: true,
      summary,
    };
  }

  if (rawIds && validIds.length < rawIds.length) {
    console.warn(
      `[script] WARN: dropped ${rawIds.length - validIds.length} used_id(s) not in candidate set`
    );
  }

  return { script, segments, usedArticleIds: validIds, usedFallback: false, summary };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a podcast script from the provided grouped articles.
 * @returns Script text plus the article IDs covered (for post-publish blacklist)
 */
export async function generateScript(
  articles: GroupedArticles
): Promise<ScriptResult> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const candidates = allCandidates(articles);
  const storyIdMap = buildStoryIdMap(articles);
  const prompt = buildPrompt(articles);

  console.log("[script] Generating podcast script via Claude...");

  const result = await withRetry(
    async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        const kinds = response.content.map((b) => b.type).join(", ") || "none";
        throw new Error(
          `No text block in Claude response (stop_reason=${String(response.stop_reason)}, blocks=[${kinds}])`
        );
      }

      return parseScriptResponse(textBlock.text, candidates, storyIdMap);
    },
    { label: "generateScript/claude", attempts: 3, baseDelayMs: 2000 }
  );

  if (result.segments.filter((s) => s.lang === "yue").length === 0) {
    console.warn("[script] WARN: no Cantonese segments — inferring from script line breaks");
    result.segments = normalizeSegments(inferSegmentsFromScript(result.script));
    validateSegments(result.segments);
  }

  console.log(
    `[script] Segments: ${result.segments.length} ` +
      `(${result.segments.filter((s) => s.lang === "en").length} en, ` +
      `${result.segments.filter((s) => s.lang === "yue").length} yue); ` +
      `greeting: "${result.segments[0]?.text.slice(0, 72)}…"`
  );

  // The script is mixed-language, so whitespace word counts undercount the
  // Cantonese section badly — CJK isn't space-delimited. Report both.
  const cjkChars = (result.script.match(/[一-鿿]/g) ?? []).length;
  const latinWords = result.script
    .replace(/[一-鿿]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  console.log(
    `[script] Done — ~${latinWords} English words + ${cjkChars} Chinese characters; ` +
      `${result.usedArticleIds.length} used id(s)` +
      (result.usedFallback ? " (fallback: all candidates)" : "") +
      (result.summary ? `; summary=${result.summary.length}ch` : "")
  );

  return result;
}
