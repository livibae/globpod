# GlobPod

Personal AI-powered morning news podcast. Fetches RSS from Hong Kong, UK, and the Netherlands, writes a bilingual script with Claude, speaks English with ElevenLabs and Hong Kong with Microsoft Edge Cantonese voices, and publishes a private podcast RSS feed on Cloudflare R2.

## Architecture

```mermaid
flowchart LR
    subgraph Sources["RSS sources"]
        HK["Hong Kong<br/>SCMP, HKFP"]
        UK["UK<br/>BBC, Guardian"]
        NL["Netherlands<br/>DutchNews, NL Times"]
    end

    Cron["Scheduler<br/>node-cron, 09:45 daily"] --> Pipeline

    subgraph Pipeline["GlobPod pipeline (Node.js / TypeScript)"]
        direction TB
        Fetch["1. Fetch + dedupe<br/>last 24h articles"]
        Script["2. Write script<br/>Claude Sonnet 5"]
        Audio["3. Text-to-speech<br/>per language segment"]
        Stitch["4. Stitch MP3<br/>ffmpeg"]
        Publish["5. Publish<br/>MP3 + RSS feed"]
        Mark["6. Blacklist used articles"]
        Fetch --> Script --> Audio --> Stitch --> Publish --> Mark
    end

    HK & UK & NL --> Fetch

    DB[("SQLite<br/>used-article blacklist")]
    Fetch <-.->|"check seen"| DB
    Mark -.->|"write used"| DB

    Audio -->|"English"| EL["ElevenLabs<br/>custom voice"]
    Audio -->|"Cantonese (HK)"| Edge["Microsoft Edge TTS<br/>zh-HK neural voice"]

    Publish --> R2[("Cloudflare R2<br/>episodes + feed.xml")]
    R2 --> Overcast["Podcast app<br/>(Overcast)"]

    Pipeline -.->|"errors / quota warnings"| Resend["Resend email"]
```

**Why two TTS providers?** ElevenLabs has no Cantonese support (Chinese text is read as Mandarin), so the Hong Kong section uses Microsoft Edge's `zh-HK` voices and is stitched together with the English parts.

## Requirements

- Node.js 24 (see `.nvmrc`) — `better-sqlite3` does not build on Node 26 yet
- Accounts/keys for: Anthropic, ElevenLabs, Cloudflare R2, Resend

## Setup

```bash
npm install
cp .env.example .env
# fill in .env
npm run build
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the pipeline once from TypeScript (`tsx`) |
| `npm run build` | Compile to `dist/` |
| `npm run run-once` | Run the compiled pipeline once |
| `npm start` | Start the daily scheduler (default **09:45** local; set `PIPELINE_CRON` in `.env`) |
| `npx tsx src/regenFeed.ts` | Rebuild channel metadata on the live feed (keeps episodes) |
| `npx tsx src/uploadHomepage.ts` | Upload the minimal HTML homepage required by feed validators |

## Pipeline

1. Purge SQLite rows older than 7 days
2. Fetch 6 RSS feeds (last 24h), skip articles already used in a published episode
3. Skip the run if fewer than `MIN_ARTICLES_FOR_EPISODE` (default 5) new articles
4. Claude writes a 10–15 min script (HK in Cantonese, UK/NL in English) + episode blurb + used article IDs
5. Check ElevenLabs quota; email a warning at ≥80%
6. TTS per segment → stitch MP3 (English: ElevenLabs; Cantonese HK: Edge `zh-HK-*`)
7. Upload MP3 + updated RSS to R2
8. Blacklist only the articles used in that published episode

Private feed URL:

```
${CF_R2_PUBLIC_URL}/feed/${FEED_SECRET_TOKEN}.xml
```

## Notes

- Daily auto-runs are **not** configured yet (see LIV-7). Prefer `npm run dev` until hosting is decided.
- Cover art and owner email still have placeholders/defaults in `src/config/podcast.ts` — override with `PODCAST_COVER_URL` / `PODCAST_OWNER_EMAIL` (see LIV-10).
- Dedup IDs are namespaced as `FeedName:guid` and only written after a successful publish (LIV-8).
