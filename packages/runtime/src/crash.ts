/**
 * @file Crash record utilities for agent crash history.
 * @module @loom/runtime/crash
 *
 * Writes and reads crash records stored as JSON files under `crashes/`
 * in the agent directory. Each file is named `{timestamp_ns}-{id}.json`.
 */

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteSync } from "./atomic-write";
import { generateId } from "./id";

export interface CrashRecord {
  /** ISO 8601 timestamp of the crash. */
  ts: string;
  /** Process exit code, or null if killed by signal. */
  exitCode: number | null;
  /** Signal name if killed by signal, otherwise null. */
  signal: string | null;
  /** Number of times the agent has been restarted so far. */
  restartCount: number;
  /** ISO 8601 timestamp of the next scheduled restart, or null if no restart planned. */
  nextRestartAt: string | null;
}

/** Write a crash record to the agent's crashes/ directory. */
export function writeCrashRecord(agentDir: string, record: CrashRecord): void {
  const crashesDir = join(agentDir, "crashes");
  mkdirSync(crashesDir, { recursive: true });

  const tsNs = BigInt(Date.now()) * 1_000_000n;
  const filename = `${tsNs}-${generateId()}.json`;
  atomicWriteSync(join(crashesDir, filename), JSON.stringify(record, null, 2));
}

/** List all crash records for an agent, sorted chronologically (oldest first). */
export function listCrashRecords(agentDir: string): CrashRecord[] {
  const crashesDir = join(agentDir, "crashes");
  mkdirSync(crashesDir, { recursive: true });

  const files = readdirSync(crashesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  return files.map((f) => JSON.parse(readFileSync(join(crashesDir, f), "utf8")) as CrashRecord);
}
