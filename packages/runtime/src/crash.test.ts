import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CrashRecord, listCrashRecords, writeCrashRecord } from "./crash";

let agentDir: string;

const sampleRecord: CrashRecord = {
  ts: "2026-03-25T05:00:00.000Z",
  exitCode: 1,
  signal: null,
  restartCount: 3,
  nextRestartAt: "2026-03-25T05:00:16.000Z",
};

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "crash-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

test("writeCrashRecord creates crashes/ directory if missing", () => {
  writeCrashRecord(agentDir, sampleRecord);
  expect(existsSync(join(agentDir, "crashes"))).toBe(true);
});

test("writeCrashRecord writes a JSON file to crashes/", () => {
  writeCrashRecord(agentDir, sampleRecord);
  const records = listCrashRecords(agentDir);
  expect(records).toHaveLength(1);
  expect(records[0]).toEqual(sampleRecord);
});

test("listCrashRecords returns empty array when no crashes", () => {
  const records = listCrashRecords(agentDir);
  expect(records).toEqual([]);
});

test("listCrashRecords returns records sorted chronologically", async () => {
  const first: CrashRecord = { ...sampleRecord, restartCount: 1 };
  writeCrashRecord(agentDir, first);
  // Small delay to ensure different timestamp_ns values
  await new Promise((r) => setTimeout(r, 2));
  const second: CrashRecord = { ...sampleRecord, restartCount: 2 };
  writeCrashRecord(agentDir, second);

  const records = listCrashRecords(agentDir);
  expect(records).toHaveLength(2);
  expect(records[0]!.restartCount).toBe(1);
  expect(records[1]!.restartCount).toBe(2);
});

test("writeCrashRecord handles signal crashes", () => {
  const signalRecord: CrashRecord = {
    ts: "2026-03-25T06:00:00.000Z",
    exitCode: null,
    signal: "SIGKILL",
    restartCount: 0,
    nextRestartAt: null,
  };
  writeCrashRecord(agentDir, signalRecord);
  const records = listCrashRecords(agentDir);
  expect(records[0]).toEqual(signalRecord);
});
