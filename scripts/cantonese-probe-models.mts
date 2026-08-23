import "dotenv/config";

const apiKey = process.env.ELEVENLABS_API_KEY!;
const voiceId = process.env.ELEVENLABS_VOICE_ID!;
const text = "大家好，呢段係廣東話測試。今日香港新聞。";
const models = ["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"];

for (const modelId of models) {
  const body: Record<string, unknown> = {
    text,
    model_id: modelId,
    voice_settings: { stability: 0.5, similarity_boost: 0.8 },
  };
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });
  console.log(`${modelId}: ${res.status} ${res.statusText} (${res.headers.get("content-type")})`);
  if (!res.ok) {
    console.log(await res.text());
  }
}
