# GlobPod — CLAUDE.md

This file is the persistent context for Claude Code acting as CTO of GlobPod.
Read this before every session.

---

## What is GlobPod

GlobPod is a personal AI-powered morning news podcast app. Each day it:
1. Fetches articles from curated RSS feeds across 3 regions
2. Summarises them using the Claude API into a podcast script
3. Generates an MP3 via ElevenLabs
4. Uploads the MP3 and updates a private RSS XML feed on Cloudflare R2
5. The user subscribes to the private RSS feed on Overcast

Built for personal use first. The goal is a working daily episode with zero 
manual intervention.

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
| Runtime | Node.js (TypeScript) |
| RSS Parsing | rss-parser |
| LLM Summarisation | Anthropic Claude API (claude-sonnet-4-20250514) |
| Audio Generation | ElevenLabs API (Multilingual v2) |
| Audio Duration Parsing | music-metadata |
| Storage | Cloudflare R2 (MP3s + RSS XML) |
| Database | SQLite via better-sqlite3 |
| Scheduling | node-cron (daily 6AM local time) |
| Error Notifications | Resend |
| Frontend | Minimal PWA — out of scope for MVP |
| Config | dotenv |

---

## Environment Variables
```
ANTHROPIC_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
CF_R2_ACCESS_KEY=
CF_R2_SECRET_KEY=
CF_R2_BUCKET_NAME=
CF_R2_ENDPOINT=
CF_R2_PUBLIC_URL=        # https://pub-<hash>.r2.dev
FEED_SECRET_TOKEN=       # random string for private feed URL
RESEND_API_KEY=
NOTIFY_EMAIL=
```

---

## News Sources (MVP, hardcoded)

**Hong Kong**
- SCMP: `https://www.scmp.com/rss/91/feed`
- Hong Kong Free Press: `https://hongkongfp.com/feed/`
- Ejinsight: `https://www.ejinsight.com/rss`

**United Kingdom**
- BBC News: `http://feeds.bbci.co.uk/news/rss.xml`
- The Guardian: `https://www.theguardian.com/uk/rss`

**Netherlands**
- DutchNews.nl: `https://www.dutchnews.nl/feed/`
- NL Times: `https://nltimes.nl/rss.xml`

---

## Pipeline (in order)

1. Fetch latest articles from all 7 RSS feeds
2. Deduplicate by `guid ?? link`, filter to last 24 hours
3. Purge SQLite articles older than 7 days
4. Group articles by region (HK / UK / NL)
5. Send grouped articles to Claude API → generate podcast script
   - Structure: intro → HK → UK → NL → outro
   - Target: 800–1000 words (~6–8 min audio)
   - Tone: calm, informed, like a trusted morning news anchor
6. Send script to ElevenLabs → receive MP3 buffer
7. Parse audio duration in seconds using music-metadata
8. Upload MP3 to R2 with filename `episodes/YYYY-MM-DD.mp3`
9. Fetch existing RSS XML from R2 (create blank feed skeleton if first run)
10. Prepend new episode, cap feed at 10 most recent episodes
11. Upload updated RSS XML to R2 at `feed/[FEED_SECRET_TOKEN].xml`
12. On any step failure → send error email via Resend with step name + error

---

## RSS Feed

- Format: valid podcast RSS 2.0 (compatible with Overcast, Apple Podcasts,
  Pocket Casts)
- Public URL pattern: `https://pub-<hash>.r2.dev/feed/[FEED_SECRET_TOKEN].xml`
- Episode audio URL pattern: `https://pub-<hash>.r2.dev/episodes/YYYY-MM-DD.mp3`
- Required fields per episode: title, pubDate, duration (seconds), 
  enclosure URL, guid

---

## Project Structure
```
globpod/
├── src/
│   ├── pipeline/
│   │   ├── fetchArticles.ts      # RSS ingestion + deduplication
│   │   ├── generateScript.ts     # Claude API summarisation
│   │   ├── generateAudio.ts      # ElevenLabs MP3 generation
│   │   ├── uploadToR2.ts         # Cloudflare R2 upload
│   │   └── updateFeed.ts         # RSS XML generation + update
│   ├── db/
│   │   └── sqlite.ts             # SQLite setup + queries
│   ├── notify.ts                 # Resend error notifications
│   ├── scheduler.ts              # node-cron daily trigger
│   └── index.ts                  # Manual pipeline runner
├── .cursor/
│   └── commands/                 # Cursor slash commands
├── .env
├── .env.example
├── CLAUDE.md
├── package.json
└── tsconfig.json
```

---

## Key Decisions Log

- **Storage**: Cloudflare R2 over AWS S3 — no egress fees at personal scale
- **Public URL**: R2 public bucket URL (`r2.dev`) — no custom domain for MVP
- **Deduplication**: `guid ?? link` as fallback chain
- **Article retention**: 7 days in SQLite then purged
- **Audio duration**: parsed from MP3 buffer via music-metadata, not estimated
- **Feed history**: capped at 10 most recent episodes
- **First run**: generate blank feed skeleton if no XML exists in R2
- **Error alerts**: Resend (simplest API, free tier sufficient)
- **Frontend**: out of scope for MVP

---

## Our Workflow

1. We brainstorm a feature or I report a bug
2. You ask all clarifying questions until you fully understand
3. You create a discovery prompt for Cursor gathering all needed context
   (file names, function names, structure)
4. Once I return Cursor's response, you ask for any missing information
5. You break the task into phases (1 phase if simple)
6. You create a Cursor prompt per phase, asking Cursor to return a status 
   report on changes made so you can catch mistakes
7. I pass phase prompts to Cursor and return status reports to you