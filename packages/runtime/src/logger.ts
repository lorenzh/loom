/**
 * @file Structured NDJSON logger for agent log files.
 * @module @loom/runtime/logger
 *
 * Appends structured JSON lines to a daily log file at `logs/{date}.ndjson`
 * inside the agent directory. Each line includes ts, level, event, and arbitrary extra fields.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

/** Appends structured log entries to the agent's daily NDJSON log file. */
export class AgentLogger {
  private readonly _logsDir: string;

  constructor(agentDir: string) {
    this._logsDir = join(agentDir, "logs");
  }

  /** Log an entry at the given level. */
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    mkdirSync(this._logsDir, { recursive: true });

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    };

    const date = entry.ts.slice(0, 10);
    const filename = join(this._logsDir, `${date}.ndjson`);
    appendFileSync(filename, JSON.stringify(entry) + "\n", "utf8");
  }

  /** Convenience method for debug-level entries. */
  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  /** Convenience method for info-level entries. */
  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }

  /** Convenience method for warn-level entries. */
  warn(event: string, fields?: Record<string, unknown>): void {
    this.log("warn", event, fields);
  }

  /** Convenience method for error-level entries. */
  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }
}
