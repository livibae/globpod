/**
 * Concatenate multiple MP3 buffers into one episode file.
 *
 * Re-encodes to 44.1 kHz mono MP3 — stream-copy concat breaks when parts use
 * different sample rates (ElevenLabs 44100 Hz vs Edge zh-HK 24000 Hz).
 */

import { createRequire } from "module";
import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static") as string;

const execFileAsync = promisify(execFile);

/**
 * Stitch MP3 parts in order. Returns a single MP3 buffer.
 */
export async function stitchMp3Buffers(parts: Buffer[]): Promise<Buffer> {
  if (parts.length === 0) {
    throw new Error("stitchMp3Buffers: no audio parts");
  }
  if (parts.length === 1) return parts[0];

  const ffmpeg = ffmpegPath;
  if (!ffmpeg) {
    throw new Error("ffmpeg-static binary not found — cannot stitch bilingual audio");
  }

  const dir = await mkdtemp(path.join(tmpdir(), "globpod-audio-"));
  try {
    const partPaths: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const partPath = path.join(dir, `part-${i}.mp3`);
      await writeFile(partPath, parts[i]);
      partPaths.push(partPath);
    }

    const outPath = path.join(dir, "output.mp3");

    // filter_complex concat decodes each part and handles mixed sample rates.
    const inputArgs = partPaths.flatMap((p) => ["-i", p]);
    const concatInputs = partPaths.map((_, i) => `[${i}:a]`).join("");
    const filter = `${concatInputs}concat=n=${partPaths.length}:v=0:a=1[outa]`;

    await execFileAsync(ffmpeg, [
      "-y",
      ...inputArgs,
      "-filter_complex",
      filter,
      "-map",
      "[outa]",
      "-c:a",
      "libmp3lame",
      "-ar",
      "44100",
      "-b:a",
      "128k",
      outPath,
    ]);

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
