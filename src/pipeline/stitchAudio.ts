/**
 * Concatenate multiple MP3 buffers into one episode file.
 * Uses ffmpeg concat demuxer (stream copy — no re-encode).
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

    // ffmpeg concat list — paths are inside a temp dir we control
    const listPath = path.join(dir, "concat.txt");
    const listContent = partPaths.map((p) => `file '${p}'`).join("\n");
    await writeFile(listPath, listContent);

    const outPath = path.join(dir, "output.mp3");
    await execFileAsync(ffmpeg, [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      outPath,
    ]);

    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
