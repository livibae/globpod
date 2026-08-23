/**
 * Audio generation for bilingual GlobPod episodes.
 *
 * English segments: ElevenLabs (custom voice).
 * Cantonese segments: Microsoft Edge zh-HK neural voices (ElevenLabs has no yue).
 * Parts are stitched into one MP3 with ffmpeg.
 *
 * Also checks ElevenLabs subscription quota and can warn when usage is high (LIV-11).
 */

import { withRetry } from "../util/retry.js";
import { synthesizeCantonese } from "./synthesizeCantonese.js";
import { stitchMp3Buffers } from "./stitchAudio.js";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

const TTS_MODEL_EN = process.env.ELEVENLABS_MODEL_EN ?? "eleven_multilingual_v2";

const QUOTA_WARN_RATIO = Number(process.env.ELEVENLABS_QUOTA_WARN_RATIO ?? 0.8);

export type SegmentLang = "en" | "yue";

export interface AudioSegment {
  lang: SegmentLang;
  text: string;
}

export interface ElevenLabsQuota {
  characterCount: number;
  characterLimit: number;
  ratio: number;
}

/**
 * Fetch current ElevenLabs character usage for the account.
 */
export async function fetchElevenLabsQuota(): Promise<ElevenLabsQuota | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;

  const response = await withRetry(
    async () => {
      const res = await fetch(`${ELEVENLABS_API_BASE}/user/subscription`, {
        headers: { "xi-api-key": apiKey },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "(no body)");
        throw new Error(
          `ElevenLabs subscription API error: ${res.status} ${res.statusText} — ${body}`
        );
      }
      return res;
    },
    { label: "elevenlabs/subscription", attempts: 3, baseDelayMs: 1500 }
  );

  const data = (await response.json()) as {
    character_count?: number;
    character_limit?: number;
  };

  const characterCount = Number(data.character_count ?? 0);
  const characterLimit = Number(data.character_limit ?? 0);
  if (!characterLimit) return null;

  return {
    characterCount,
    characterLimit,
    ratio: characterCount / characterLimit,
  };
}

/**
 * True when usage is at/above the warning threshold (default 80%).
 */
export function isQuotaWarning(quota: ElevenLabsQuota): boolean {
  return quota.ratio >= QUOTA_WARN_RATIO;
}

const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.8,
  style: 0.0,
  use_speaker_boost: true,
};

/**
 * Infer language segments from a flat script (fallback when JSON has no segments).
 * Splits on paragraph breaks, then merges lines by language when needed.
 */
export function inferSegmentsFromScript(script: string): AudioSegment[] {
  const blocks = script.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const segments: AudioSegment[] = [];

  for (const block of blocks) {
    segments.push(...inferSegmentsFromLines(block));
  }

  if (segments.length === 0 && script.trim()) {
    return inferSegmentsFromLines(script.trim());
  }

  return segments;
}

/** Merge consecutive lines that share the same inferred language. */
function inferSegmentsFromLines(text: string): AudioSegment[] {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const segments: AudioSegment[] = [];
  let currentLang: SegmentLang = isCantoneseParagraph(lines[0]) ? "yue" : "en";
  let currentLines: string[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const lang: SegmentLang = isCantoneseParagraph(line) ? "yue" : "en";
    if (lang === currentLang) {
      currentLines.push(line);
    } else {
      segments.push({ lang: currentLang, text: currentLines.join("\n") });
      currentLang = lang;
      currentLines = [line];
    }
  }

  segments.push({ lang: currentLang, text: currentLines.join("\n") });
  return segments;
}

function isCantoneseParagraph(text: string): boolean {
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (cjkChars < 8) return false;
  const latinWords = text.replace(/[\u4e00-\u9fff]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjkChars >= latinWords * 2;
}

async function synthesizeEnglish(
  apiKey: string,
  voiceId: string,
  text: string,
  label: string
): Promise<Buffer> {
  const body = {
    text,
    model_id: TTS_MODEL_EN,
    voice_settings: DEFAULT_VOICE_SETTINGS,
  };

  const response = await withRetry(
    async () => {
      const res = await fetch(
        `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const errorText = await res.text().catch(() => "(no body)");
        throw new Error(
          `ElevenLabs API error (${label}): ${res.status} ${res.statusText} — ${errorText}`
        );
      }
      return res;
    },
    { label: `generateAudio/${label}`, attempts: 3, baseDelayMs: 2000 }
  );

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function synthesizeSegment(
  apiKey: string,
  voiceId: string,
  segment: AudioSegment,
  label: string
): Promise<Buffer> {
  if (segment.lang === "yue") {
    return synthesizeCantonese(segment.text);
  }
  return synthesizeEnglish(apiKey, voiceId, segment.text, label);
}

/**
 * Convert labeled script segments to one MP3.
 */
export async function generateAudio(segments: AudioSegment[]): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    throw new Error(
      "Missing required env vars: ELEVENLABS_API_KEY and/or ELEVENLABS_VOICE_ID"
    );
  }

  if (segments.length === 0) {
    throw new Error("generateAudio: no segments to synthesize");
  }

  const yueCount = segments.filter((s) => s.lang === "yue").length;
  const enCount = segments.filter((s) => s.lang === "en").length;
  console.log(
    `[audio] Synthesizing ${segments.length} segment(s): ${enCount} English (ElevenLabs), ${yueCount} Cantonese (Edge zh-HK)`
  );

  const parts: Buffer[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const chars = seg.lang === "yue"
      ? (seg.text.match(/[\u4e00-\u9fff]/g) ?? []).length
      : seg.text.length;
    const provider =
      seg.lang === "yue"
        ? `Edge ${process.env.CANTONESE_TTS_VOICE ?? "zh-HK-HiuMaanNeural"}`
        : `ElevenLabs ${TTS_MODEL_EN}`;
    console.log(
      `[audio] Segment ${i + 1}/${segments.length} (${seg.lang}, ~${chars} chars, ${provider})`
    );
    const part = await synthesizeSegment(apiKey, voiceId, seg, `seg${i + 1}-${seg.lang}`);
    parts.push(part);
  }

  const buffer = await stitchMp3Buffers(parts);
  const sizeKb = Math.round(buffer.length / 1024);
  console.log(`[audio] Done — ${sizeKb} KB MP3 (${parts.length} part(s) stitched)`);

  return buffer;
}
