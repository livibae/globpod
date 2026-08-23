/**
 * Audio generation via ElevenLabs API.
 *
 * Sends the podcast script to ElevenLabs (Multilingual v2 model)
 * and returns the resulting MP3 as a Node.js Buffer.
 *
 * ElevenLabs does not have an official Node SDK we depend on here;
 * we call the REST API directly using fetch (built into Node 18+).
 */

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

// ElevenLabs Multilingual v2 — best quality for multi-language scripts
const TTS_MODEL = "eleven_multilingual_v2";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

  const response = await fetch(
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
          stability: 0.5,       // balanced between consistent and expressive
          similarity_boost: 0.8, // high fidelity to the selected voice
          style: 0.0,            // no extra style exaggeration
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(no body)");
    throw new Error(
      `ElevenLabs API error: ${response.status} ${response.statusText} — ${errorText}`
    );
  }

  // Stream the response body into a Buffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const sizeKb = Math.round(buffer.length / 1024);
  console.log(`[audio] Done — ${sizeKb} KB MP3 received`);

  return buffer;
}
