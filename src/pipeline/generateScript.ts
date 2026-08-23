/**
 * Podcast script generation via Anthropic Claude API.
 *
 * Takes grouped articles (HK / UK / NL) and returns a 10–15 minute script
 * structured as: greeting → HK → UK → NL → sign-off.
 *
 * The Hong Kong section is written in colloquial Cantonese (廣東話); every
 * other section is English. One paragraph per story, three stories per
 * region. See LIV-9 for the rationale.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { GroupedArticles } from "./fetchArticles.js";

const MODEL = "claude-sonnet-5";

// Generous ceiling, not a target. Sonnet 5 runs adaptive thinking by default,
// and thinking tokens count toward this budget — 2048 risks truncation.
const MAX_TOKENS = 16000;

// Stories selected per region. The model sees more candidates than this and
// picks the best ones — see CANDIDATES_PER_REGION.
const STORIES_PER_REGION = 3;

// How many articles per region Claude gets to choose from.
const CANDIDATES_PER_REGION = 8;

// Source summary characters passed per article. More grounding material means
// less temptation to invent detail when writing a long paragraph.
const SUMMARY_CHARS = 600;

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

FORMAT

Spoken prose only. No markdown, no headers, no bullet points, no section labels, no stage directions, no speaker names. Never write words like "Intro", "Outro", or "Hong Kong section" — nothing that is not meant to be said out loud. Paragraph breaks are the only structure you have.`;

/**
 * Format a region's candidate articles as a readable block for the prompt.
 */
function formatArticles(
  articles: GroupedArticles["hk"],
  regionLabel: string
): string {
  if (articles.length === 0) {
    return `### ${regionLabel}\n(No new articles in the last 24 hours)`;
  }

  const items = articles
    .slice(0, CANDIDATES_PER_REGION)
    .map(
      (a, i) =>
        `${i + 1}. **${a.title}** (${a.feedName})\n   ${a.summary.slice(0, SUMMARY_CHARS)}`
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

  const hkBlock = formatArticles(articles.hk, "Hong Kong");
  const ukBlock = formatArticles(articles.uk, "United Kingdom");
  const nlBlock = formatArticles(articles.nl, "Netherlands");

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
- Give every story its OWN paragraph. Never chain two stories into one paragraph.
- Each story gets at least three or four sentences — at the length target above, that usually means six to ten. Say what happened, then who it affects and why it matters, then whatever context makes it land.
- If the day's news is a follow-up to an ongoing story — a deadline, a response, an update, a "no delay", a next hearing, a second vote — open with one plain sentence of backstory before the update. Assume she may have missed earlier chapters. Example shape: what the original event/scheme was, then today's development. Keep that backstory to one sentence, not a full history lesson.
- Do not bridge stories with connective filler. No "Meanwhile", "Elsewhere", "Turning to", "Moving on", "And on the economic front". Begin each paragraph on its own subject.
- If a region has fewer than ${STORIES_PER_REGION} genuinely usable stories, cover the ones that exist properly instead of padding to reach the number.

CANDIDATE ARTICLES

${hkBlock}

${ukBlock}

${nlBlock}

Write only the script itself. No preamble, no commentary, no notes to me.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a podcast script from the provided grouped articles.
 * @returns The raw script string (plain prose, ready for TTS)
 */
export async function generateScript(articles: GroupedArticles): Promise<string> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const prompt = buildPrompt(articles);

  console.log("[script] Generating podcast script via Claude...");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  // Find the text block. Don't assume content[0] — Sonnet 5 has adaptive
  // thinking on by default, so thinking blocks can precede the text.
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    const kinds = response.content.map((b) => b.type).join(", ") || "none";
    throw new Error(
      `No text block in Claude response (stop_reason=${String(response.stop_reason)}, blocks=[${kinds}])`
    );
  }

  const script = textBlock.text.trim();

  // The script is mixed-language, so whitespace word counts undercount the
  // Cantonese section badly — CJK isn't space-delimited. Report both.
  const cjkChars = (script.match(/[一-鿿]/g) ?? []).length;
  const latinWords = script
    .replace(/[一-鿿]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  console.log(
    `[script] Done — ~${latinWords} English words + ${cjkChars} Chinese characters`
  );

  return script;
}
