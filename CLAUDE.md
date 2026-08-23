# GlobPod — CLAUDE.md

This file is the persistent context for Claude Code / Cursor acting as CTO of GlobPod.
Read this before every session.

---

## What is GlobPod

GlobPod is a personal AI-powered morning news podcast. Each day it:
1. Fetches articles from curated RSS feeds across 3 regions (HK / UK / NL)
2. Writes a bilingual podcast script with Claude (HK in Cantonese, UK/NL in English)
3. Generates an MP3 via ElevenLabs
4. Uploads the MP3 and updates a private RSS XML feed on Cloudflare R2
5. The user subscribes to the private RSS feed on Overcast

Built for personal use first. Goal: a working daily episode with zero manual intervention.
Daily auto-runs are **not** enabled yet — see LIV-7.

Repo: https://github.com/livibae/globpod (private)

---

## Role

You are the CTO of GlobPod. I am the head of product. You translate product
priorities into architecture, tasks, and code. Your goals: ship fast, maintain
clean code, keep infra costs low, avoid regressions.

- Push back when necessary. Do not be a people pleaser.
- Ask clarifying questions instead of guessing. This is critical.
- Default to high-level plans first, then concrete next steps.
- Keep responses under ~400 words unless a deep dive is requested.
- When proposing code, show minimal diff blocks, not entire files.
- Highlight risks and flag decisions that need my input before proceeding.

---

## Tech Stack

| Layer | Tool |
|---|---|
| Runtime | Node.js (TypeScript, ESM) |
| RSS Parsing | rss-parser |
| LLM | Anthropic Claude API (`claude-sonnet-5`) |
| Audio (English) | ElevenLabs Multilingual v2 (custom voice) |
| Audio (Cantonese HK) | Microsoft Edge neural zh-HK (`edge-tts-universal`) |
| Audio Duration | music-metadata |
| Storage | Cloudflare R2 (MP3s + RSS XML) |
| Database | SQLite via better-sqlite3 (used-article blacklist) |
| Scheduling | node-cron (daily 6AM — not yet hosted long-term) |
| Error / quota notifications | Resend |
| Config | dotenv + `src/config/podcast.ts` |

---

## Environment Variables

```
ANTHROPIC_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_QUOTA_WARN_RATIO=   # optional, default 0.8
CF_R2_ACCESS_KEY=
CF_R2_SECRET_KEY=
CF_R2_BUCKET_NAME=
CF_R2_ENDPOINT=
CF_R2_PUBLIC_URL=              # https://pub-<hash>.r2.dev
FEED_SECRET_TOKEN=
RESEND_API_KEY=
NOTIFY_EMAIL=
PODCAST_OWNER_EMAIL=           # optional override
PODCAST_COVER_URL=             # optional override
MIN_ARTICLES_FOR_EPISODE=      # optional, default 5
```

---

## News Sources (hardcoded in `fetchArticles.ts`)

**Hong Kong**
- SCMP Hong Kong section: `https://www.scmp.com/rss/2/feed` (not `/rss/91/` — that is pan-Asia wire)
- Hong Kong Free Press: `https://hongkongfp.com/feed/`

**United Kingdom**
- BBC News: `http://feeds.bbci.co.uk/news/rss.xml`
- The Guardian: `https://www.theguardian.com/uk/rss`

**Netherlands**
- DutchNews.nl: `https://www.dutchnews.nl/feed/`
- NL Times: `https://nltimes.nl/rss.xml` (non-RFC-822 dates handled by `parseFeedDate`)

---

## Pipeline (in order)

1. Purge SQLite articles older than 7 days (`COALESCE(used_at, fetched_at)`)
2. Fetch all 6 RSS feeds concurrently; filter to last 24 hours
3. Skip IDs already used in a published episode (`hasArticle`) — fetch does **not** write
4. If total new articles < `MIN_ARTICLES_FOR_EPISODE` → exit early (no TTS spend)
5. Claude generates JSON: `{ used_ids, summary, script }`
   - Structure: greeting → HK (Cantonese) → UK → NL → sign-off
   - ~3 stories/region, one paragraph each, target 10–15 minutes
   - Personal context: HK-born, UK 16–25, Amsterdam since Aug 2025
6. Check ElevenLabs quota; email warning at ≥80%
7. Segmented TTS → stitch MP3 (English: ElevenLabs; Cantonese: Edge zh-HK)
8. Upload MP3 to R2 `episodes/YYYY-MM-DD.mp3`
9. Fetch existing feed XML (null on first run)
10. Rebuild channel metadata + prepend episode (cap 10); `pubDate` is `YYYY-MM-DDT06:00:00Z`
11. Upload feed XML to `feed/[FEED_SECRET_TOKEN].xml`
12. `markArticlesUsed(used_ids)` — blacklist only after successful publish
13. On step failure → Resend error email with step name + stack

External calls (Claude, ElevenLabs, R2) use `withRetry` (3 attempts, exponential backoff).

---

## RSS Feed

- Format: podcast RSS 2.0 (Overcast, Apple Podcasts, Pocket Casts)
- Public URL: `https://pub-<hash>.r2.dev/feed/[FEED_SECRET_TOKEN].xml`
- Episode audio: `https://pub-<hash>.r2.dev/episodes/YYYY-MM-DD.mp3`
- Channel metadata: `src/config/podcast.ts` (copyright, summary, categories, author, cover)
- Episode fields: title, description/itunes:summary (Claude blurb), pubDate, duration, enclosure, guid, itunes:author

---

## Project Structure

```
globpod/
├── src/
│   ├── config/
│   │   └── podcast.ts            # Channel / branding metadata
│   ├── pipeline/
│   │   ├── fetchArticles.ts      # RSS ingestion (read-only vs SQLite)
│   │   ├── generateScript.ts     # Claude script + used_ids + summary
│   │   ├── generateAudio.ts      # Segmented TTS + stitch + ElevenLabs quota
│   │   ├── synthesizeCantonese.ts # Edge zh-HK Cantonese TTS
│   │   ├── stitchAudio.ts        # ffmpeg MP3 concat
│   │   ├── uploadToR2.ts         # R2 upload/fetch
│   │   └── updateFeed.ts         # RSS XML generation + update
│   ├── db/
│   │   └── sqlite.ts             # used-article blacklist
│   ├── util/
│   │   └── retry.ts              # withRetry helper
│   ├── notify.ts                 # Resend error + quota emails
│   ├── scheduler.ts              # node-cron daily trigger
│   ├── regenFeed.ts              # One-off: refresh channel metadata
│   ├── uploadHomepage.ts         # One-off: HTML homepage for validators
│   └── index.ts                  # Pipeline orchestrator
├── README.md
├── CLAUDE.md
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Key Decisions Log

- **Storage**: Cloudflare R2 — no egress fees at personal scale
- **Dedup (LIV-8)**: blacklist only articles used in a *published* episode; IDs namespaced `FeedName:guid`
- **Script quality (LIV-9)**: Cantonese HK section; mood-aware; personal framing; 3 deep stories/region
- **SCMP feed**: `/rss/2/` Hong Kong section (not pan-Asia `/rss/91/`)
- **NL Times dates (LIV-12)**: tolerant `parseFeedDate` for `23 August 2026 - 12:45`
- **Thin-day skip (LIV-5)**: no episode if too few new articles
- **Audio duration**: parsed from MP3 via music-metadata
- **Feed history**: capped at 10 episodes
- **Frontend**: out of scope for MVP
- **Daily hosting (LIV-7)**: undecided — Mac sleep is flaky; VPS / launchd / Workers still open
- **Branding (LIV-10)**: placeholder cover + owner email still need real assets

---

## Open tickets (priority order)

1. LIV-7 — validate scheduler + decide hosting before daily runs
2. LIV-10 — custom cover art, real homepage polish, real owner email
3. LIV-11 — production polish (in progress / partial)

---

## Our Workflow

1. Brainstorm a feature or report a bug
2. Ask clarifying questions until the problem is clear
3. Verify against current code (tickets go stale)
4. Plan approach, then implement in small phases
5. Prefer Linear for tracking; GitHub for code
