/** Restart policy for an agent. */
export type RestartPolicy = "always" | "on-failure" | "never";

/** Record of a single agent crash, persisted to the crashes/ directory. */
export interface CrashRecord {
  ts: string;
  exitCode: number | null;
  signal: string | null;
  restartCount: number;
  nextRestartAt: string | null;
}

export interface BackoffOptions {
  baseDelayMs: number;
  maxBackoffMs: number;
  maxRestarts: number;
  resetWindowMs: number;
}

const DEFAULT_BACKOFF: BackoffOptions = {
  baseDelayMs: 1_000,
  maxBackoffMs: 300_000,
  maxRestarts: 10,
  resetWindowMs: 3_600_000,
};

/** Compute the next restart delay using exponential backoff with jitter. */
export function computeBackoff(restartCount: number, opts: Partial<BackoffOptions> = {}): number {
  const { baseDelayMs, maxBackoffMs } = { ...DEFAULT_BACKOFF, ...opts };
  const delay = Math.min(baseDelayMs * 2 ** restartCount, maxBackoffMs);
  const jitter = Math.random() * 500;
  return delay + jitter;
}

/** Check whether the agent has exceeded its restart limit. */
export function isMaxRestartsExceeded(
  restartCount: number,
  opts: Partial<BackoffOptions> = {},
): boolean {
  const { maxRestarts } = { ...DEFAULT_BACKOFF, ...opts };
  return restartCount >= maxRestarts;
}
