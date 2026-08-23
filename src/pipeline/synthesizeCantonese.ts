/**
 * Cantonese TTS via Microsoft Edge neural voices (edge-tts-universal).
 *
 * ElevenLabs does not support Cantonese synthesis — multilingual_v2 maps Chinese
 * to Mandarin. Edge TTS provides zh-HK voices with no API key required.
 */

import { EdgeTTS } from "edge-tts-universal";
import { withRetry } from "../util/retry.js";

const DEFAULT_VOICE = "zh-HK-HiuMaanNeural";

/**
 * Synthesize Cantonese text to an MP3 buffer.
 */
export async function synthesizeCantonese(text: string): Promise<Buffer> {
  const voice = process.env.CANTONESE_TTS_VOICE ?? DEFAULT_VOICE;

  const result = await withRetry(
    async () => {
      const tts = new EdgeTTS(text, voice);
      return await tts.synthesize();
    },
    { label: "cantoneseTTS", attempts: 3, baseDelayMs: 2000 }
  );

  const arrayBuffer = await result.audio.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
