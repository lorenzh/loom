import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry } from "@losoft/loom-runtime";

const DEFAULT_LINES = 50;
const FOLLOW_POLL_MS = 200;

export interface LogsOptions {
  signal?: AbortSignal;
}

/** Level label padded to a fixed width for aligned output. */
const LEVEL_LABEL: Record<string, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

/** Format a single log entry as a human-readable line. */
function formatEntry(entry: LogEntry): string {
  const { ts, level, event, ...rest } = entry;
  const label = LEVEL_LABEL[level] ?? level.toUpperCase().padEnd(5);
  const extra =
    Object.keys(rest).length > 0
      ? "  " +
        Object.entries(rest)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(" ")
      : "";
  return `${ts}  ${label}  ${event}${extra}`;
}

/** Parse NDJSON text into LogEntry objects, skipping malformed lines. */
function parseEntries(text: string): LogEntry[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as LogEntry];
      } catch {
        return [];
      }
    });
}

/** List NDJSON log filenames in the given directory, sorted oldest-first. */
function listLogFiles(logsDir: string): string[] {
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter((f) => f.endsWith(".ndjson"))
    .sort();
}

/** Sleep for `ms` milliseconds, resolving early if `signal` is aborted. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** View agent logs. Supports --lines/-n and --follow/-f. */
export async function logs(args: string[], loomHome: string, options?: LogsOptions): Promise<void> {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    throw new Error("Usage: loom agent logs <name> [--lines N] [--follow]");
  }

  const follow = args.includes("--follow") || args.includes("-f");

  const linesIdx = args.findIndex((a) => a === "--lines" || a === "-n");
  const rawLines = linesIdx !== -1 ? Number(args[linesIdx + 1]) : DEFAULT_LINES;
  if (!Number.isInteger(rawLines) || rawLines < 1) {
    throw new Error("--lines must be a positive integer");
  }
  const maxLines = rawLines;

  const logsDir = join(loomHome, "agents", name, "logs");

  const files = listLogFiles(logsDir);
  let activeFile = files.at(-1) ?? null;

  if (files.length === 0 && !follow) {
    console.log("No log files found.");
    return;
  }

  // Print initial tail
  let printedCount = 0;
  if (activeFile) {
    const entries = parseEntries(readFileSync(join(logsDir, activeFile), "utf8"));
    const tail = entries.slice(-maxLines);
    for (const entry of tail) {
      console.log(formatEntry(entry));
    }
    printedCount = entries.length;
  }

  if (!follow) return;

  // Streaming: poll for new entries
  const signal = options?.signal;
  while (!signal?.aborted) {
    await sleep(FOLLOW_POLL_MS, signal);
    if (signal?.aborted) break;

    // Check for a newer log file (day rollover)
    const current = listLogFiles(logsDir);
    const newest = current.at(-1) ?? null;
    if (newest !== activeFile) {
      activeFile = newest;
      printedCount = 0;
    }

    if (!activeFile) continue;

    const entries = parseEntries(readFileSync(join(logsDir, activeFile), "utf8"));
    const newEntries = entries.slice(printedCount);
    for (const entry of newEntries) {
      console.log(formatEntry(entry));
    }
    printedCount = entries.length;
  }
}
