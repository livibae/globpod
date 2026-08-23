/**
 * Strip metadata that must never be read aloud (URLs, story ids, JSON keys).
 */

const URL_PATTERN = /https?:\/\/[^\s\]"')]+/gi;
const NAMESPACED_URL_PATTERN = /\b[A-Za-z][\w.-]*:https?:\/\/[^\s\]"')]+/gi;

/** Remove URLs, ids, and other non-speech artifacts from TTS input. */
export function sanitizeForSpeech(text: string): string {
  let t = text;

  // Drop lines that look like JSON metadata
  t = t.replace(/^[\s]*["']?(used_ids|segments|summary|story_id|lang|text)["']?\s*[:[{].*$/gim, "");

  t = t.replace(URL_PATTERN, "");
  t = t.replace(NAMESPACED_URL_PATTERN, "");
  t = t.replace(/\bstory_id\s*=\s*[^\s\n]+/gi, "");
  t = t.replace(/\bid=[^\s\n]+/gi, "");
  t = t.replace(/\*\*/g, "");
  t = t.replace(/\s{2,}/g, " ").trim();

  return t;
}

export function containsSpeechArtifacts(text: string): boolean {
  return (
    /https?:\/\//i.test(text) ||
    /\bstory_id\b/i.test(text) ||
    /\bid=https?:/i.test(text) ||
    /"used_ids"/i.test(text)
  );
}
