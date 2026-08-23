/**
 * Quick bilingual TTS probe: English (ElevenLabs) + Cantonese (Edge zh-HK).
 * Usage: npx tsx scripts/cantonese-probe.mts
 */
import "dotenv/config";
import { writeFile } from "fs/promises";
import { generateAudio } from "../src/pipeline/generateAudio.js";

const segments = [
  { lang: "en" as const, text: "GlobPod Cantonese probe. English first." },
  { lang: "yue" as const, text: "大家好，呢段係廣東話測試。今日香港新聞。" },
];

console.log("Synthesizing probe...");
const buf = await generateAudio(segments);
const out = "cantonese-probe.mp3";
await writeFile(out, buf);
console.log(`Written ${buf.length} bytes to ${out}`);
