/**
 * Small retry helper for transient external API failures (LIV-11).
 *
 * Retries on network errors and HTTP-ish status codes 408/429/5xx when the
 * thrown Error message includes them (our fetch wrappers do).
 */

export interface RetryOptions {
  attempts?: number; // total tries, default 3
  baseDelayMs?: number; // default 2000
  label?: string; // for log lines
  /** Return false to skip retry for this error. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultShouldRetry(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const msg = err.message;

  // Explicit non-retryable client errors
  if (/\b(401|403|404)\b/.test(msg)) return false;

  // Transient / rate-limit / overload
  if (/\b(408|429|500|502|503|504|529)\b/.test(msg)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network/i.test(msg)) return true;
  if (/overloaded|rate.?limit|timeout|temporar/i.test(msg)) return true;

  // Unknown errors: retry once-ish via caller attempts
  return true;
}

/**
 * Run `fn` with exponential backoff on transient failures.
 * Delay sequence: base, base*2, base*4, ... (+ small jitter).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;
  const label = options.label ?? "operation";
  const shouldRetry = options.shouldRetry ?? ((err) => defaultShouldRetry(err));

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = shouldRetry(err, attempt);
      if (!retryable || attempt === attempts) break;

      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[retry] ${label} failed (attempt ${attempt}/${attempts}): ${msg} — retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
