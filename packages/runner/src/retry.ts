import { ModelNotFoundError, ProviderAuthError, ToolCallParseError } from "./errors";

/** Whether an error is worth retrying or should fail immediately. */
export type ErrorKind = "transient" | "permanent";

/**
 * Classify an LLM error as transient (retry) or permanent (fail immediately).
 *
 * Permanent: auth failures, missing models, malformed tool call arguments.
 * Transient: everything else — network errors, rate limits, 5xx responses.
 */
export function classifyError(err: unknown): ErrorKind {
  if (err instanceof ProviderAuthError) return "permanent";
  if (err instanceof ModelNotFoundError) return "permanent";
  if (err instanceof ToolCallParseError) return "permanent";
  return "transient";
}

/** Thrown when all retry attempts are exhausted. Wraps the original error. */
export class RetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public override readonly cause: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`All ${attempts} attempt(s) failed: ${msg}`);
    this.name = "RetryExhaustedError";
  }
}

/**
 * Call `fn` with exponential backoff retries for transient errors.
 *
 * - Permanent errors are re-thrown immediately (no retry).
 * - After all retries are exhausted, throws `RetryExhaustedError`.
 * - Backoff: baseDelayMs * 2^attempt (1s, 2s, 4s by default).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (classifyError(err) === "permanent") throw err;
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise<void>((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
      }
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastErr);
}
