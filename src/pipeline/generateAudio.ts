/**
 * Audio generation via ElevenLabs API.
 *
 * Sends the podcast script to ElevenLabs (Multilingual v2 model)
 * and returns the resulting MP3 as a Node.js Buffer.
 *
 * Also checks subscription quota and can warn when usage is high (LIV-11).
 */

import { withRetry } from "../util/retry.js";

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

// ElevenLabs Multilingual v2 — best quality for multi-language scripts
const TTS_MODEL = "eleven_multilingual_v2";

const QUOTA_WARN_RATIO = Number(process.env.ELEVENLABS_QUOTA_WARN_RATIO ?? 0.8);

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

/**
 * Convert a text script to MP3 audio using ElevenLabs TTS.
 * @param script - Plain-text podcast script (no markdown)
 * @returns MP3 audio as a Buffer
 */
export async function generateAudio(script: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    throw new Error(
      "Missing required env vars: ELEVENLABS_API_KEY and/or ELEVENLABS_VOICE_ID"
    );
  }

  console.log("[audio] Sending script to ElevenLabs TTS...");

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
          body: JSON.stringify({
            text: script,
            model_id: TTS_MODEL,
            voice_settings: {
              stability: 0.5, // balanced between consistent and expressive
              similarity_boost: 0.8, // high fidelity to the selected voice
              style: 0.0, // no extra style exaggeration
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!res.ok) {
        const errorText = await res.text().catch(() => "(no body)");
        throw new Error(
          `ElevenLabs API error: ${res.status} ${res.statusText} — ${errorText}`
        );
      }
      return res;
    },
    { label: "generateAudio/elevenlabs", attempts: 3, baseDelayMs: 2000 }
  );

  // Stream the response body into a Buffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const sizeKb = Math.round(buffer.length / 1024);
  console.log(`[audio] Done — ${sizeKb} KB MP3 received`);

  return buffer;
}
