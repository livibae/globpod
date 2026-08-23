/**
 * Cantonese-only TTS probe (no stitching).
 * Usage: npx tsx scripts/cantonese-only-probe.mts
 */
import "dotenv/config";
import { writeFile } from "fs/promises";
import { synthesizeCantonese } from "../src/pipeline/synthesizeCantonese.js";

const text = "大家好，呢段係廣東話測試。今日香港新聞。";
console.log("Synthesizing Cantonese only...");
const buf = await synthesizeCantonese(text);
const out = "cantonese-only-probe.mp3";
await writeFile(out, buf);
console.log(`Written ${buf.length} bytes to ${out}`);
