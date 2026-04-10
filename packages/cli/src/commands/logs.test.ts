/// <reference types="bun" />
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logs } from "./logs";

let loomHome: string;
const AGENT = "test-agent";

beforeEach(() => {
  loomHome = mkdtempSync(join(tmpdir(), "loom-home-"));
});

afterEach(() => {
  rmSync(loomHome, { recursive: true, force: true });
});

/** Capture console.log calls during `fn`, returning all logged strings. */
async function captureOutput(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log.bind(console);
  console.log = mock((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof console.log;
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** Write NDJSON log entries to `agents/<name>/logs/<date>.ndjson`. */
function writeLogFile(date: string, entries: object[]): string {
  const logsDir = join(loomHome, "agents", AGENT, "logs");
  mkdirSync(logsDir, { recursive: true });
  const file = join(logsDir, `${date}.ndjson`);
  for (const entry of entries) {
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  }
  return file;
}

// ── arg validation ────────────────────────────────────────────────────────────

test("throws when agent name is missing", async () => {
  await expect(logs([], loomHome)).rejects.toThrow("Usage:");
});

test("throws when --lines value is not a positive integer", async () => {
  await expect(logs([AGENT, "--lines", "abc"], loomHome)).rejects.toThrow("positive integer");
  await expect(logs([AGENT, "--lines", "0"], loomHome)).rejects.toThrow("positive integer");
});

// ── no logs ───────────────────────────────────────────────────────────────────

test("prints no-logs message when logs directory is empty", async () => {
  const output = await captureOutput(() => logs([AGENT], loomHome));
  expect(output).toEqual(["No log files found."]);
});

// ── reading logs ──────────────────────────────────────────────────────────────

test("formats log entries as human-readable lines", async () => {
  writeLogFile("2026-04-10", [
    { ts: "2026-04-10T01:00:00.000Z", level: "info", event: "message_received" },
    { ts: "2026-04-10T01:00:01.000Z", level: "error", event: "provider_failed", code: 500 },
  ]);

  const output = await captureOutput(() => logs([AGENT], loomHome));

  expect(output).toHaveLength(2);
  expect(output[0]).toContain("INFO ");
  expect(output[0]).toContain("message_received");
  expect(output[1]).toContain("ERROR");
  expect(output[1]).toContain("provider_failed");
  expect(output[1]).toContain("code=500");
});

test("reads the most recent log file when multiple exist", async () => {
  writeLogFile("2026-04-08", [
    { ts: "2026-04-08T01:00:00.000Z", level: "info", event: "old_event" },
  ]);
  writeLogFile("2026-04-10", [
    { ts: "2026-04-10T01:00:00.000Z", level: "info", event: "new_event" },
  ]);

  const output = await captureOutput(() => logs([AGENT], loomHome));

  expect(output).toHaveLength(1);
  expect(output[0]).toContain("new_event");
});

test("--lines limits output to N most recent entries", async () => {
  writeLogFile("2026-04-10", [
    { ts: "2026-04-10T01:00:00.000Z", level: "info", event: "first" },
    { ts: "2026-04-10T01:00:01.000Z", level: "info", event: "second" },
    { ts: "2026-04-10T01:00:02.000Z", level: "info", event: "third" },
  ]);

  const output = await captureOutput(() => logs([AGENT, "--lines", "2"], loomHome));

  expect(output).toHaveLength(2);
  expect(output[0]).toContain("second");
  expect(output[1]).toContain("third");
});

test("-n is an alias for --lines", async () => {
  writeLogFile("2026-04-10", [
    { ts: "2026-04-10T01:00:00.000Z", level: "info", event: "first" },
    { ts: "2026-04-10T01:00:01.000Z", level: "info", event: "second" },
  ]);

  const output = await captureOutput(() => logs([AGENT, "-n", "1"], loomHome));
  expect(output).toHaveLength(1);
  expect(output[0]).toContain("second");
});

test("skips malformed NDJSON lines without throwing", async () => {
  const logsDir = join(loomHome, "agents", AGENT, "logs");
  mkdirSync(logsDir, { recursive: true });
  const file = join(logsDir, "2026-04-10.ndjson");
  appendFileSync(file, '{"ts":"2026-04-10T01:00:00.000Z","level":"info","event":"ok"}\n', "utf8");
  appendFileSync(file, "not valid json\n", "utf8");

  const output = await captureOutput(() => logs([AGENT], loomHome));
  expect(output).toHaveLength(1);
  expect(output[0]).toContain("ok");
});

// ── --follow ──────────────────────────────────────────────────────────────────

test("--follow streams new entries appended after initial read", async () => {
  const logFile = writeLogFile("2026-04-10", [
    { ts: "2026-04-10T01:00:00.000Z", level: "info", event: "initial" },
  ]);

  const controller = new AbortController();
  const output: string[] = [];
  const original = console.log.bind(console);
  console.log = mock((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  }) as typeof console.log;

  const followPromise = logs([AGENT, "--follow"], loomHome, { signal: controller.signal });

  // Wait for initial entry to be printed, then append a new entry
  await new Promise<void>((r) => setTimeout(r, 100));
  appendFileSync(
    logFile,
    '{"ts":"2026-04-10T01:00:01.000Z","level":"warn","event":"new_entry"}\n',
    "utf8",
  );

  // Wait for the new entry to be picked up
  await new Promise<void>((r) => setTimeout(r, 500));
  controller.abort();
  await followPromise;

  console.log = original;

  expect(output.some((l) => l.includes("initial"))).toBe(true);
  expect(output.some((l) => l.includes("new_entry"))).toBe(true);
});

test("--follow exits cleanly when signal is aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  // Should resolve without hanging
  await expect(
    logs([AGENT, "--follow"], loomHome, { signal: controller.signal }),
  ).resolves.toBeUndefined();
});
