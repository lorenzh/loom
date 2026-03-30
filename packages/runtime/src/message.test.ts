import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consume, isMessage, list, quarantine, read, send } from "./message";

let root: string;
const AGENT = "test-agent";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "message-"));
  mkdirSync(join(root, AGENT, "inbox"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- isMessage ---

test("isMessage returns true for valid message", () => {
  expect(isMessage({ v: 1, id: "abc", from: "sender", ts: 123, body: "hello" })).toBe(true);
});

test("isMessage returns false for null", () => {
  expect(isMessage(null)).toBe(false);
});

test("isMessage returns false for missing fields", () => {
  expect(isMessage({ v: 1, id: "abc" })).toBe(false);
});

test("isMessage returns false for wrong types", () => {
  expect(isMessage({ v: "1", id: "abc", ts: 123, body: "hello" })).toBe(false);
  expect(isMessage({ v: 1, id: 123, ts: 123, body: "hello" })).toBe(false);
  expect(isMessage({ v: 1, id: "abc", ts: "123", body: "hello" })).toBe(false);
  expect(isMessage({ v: 1, id: "abc", ts: 123, body: 456 })).toBe(false);
});

// --- send ---

test("send creates a message file and returns the message", async () => {
  const msg = await send(root, AGENT, "sender", "hello world");

  expect(msg.v).toBe(1);
  expect(msg.id).toBeString();
  expect(msg.id).toHaveLength(16);
  expect(msg.ts).toBeNumber();
  expect(msg.from).toBe("sender");
  expect(msg.body).toBe("hello world");
});

test("send writes valid JSON to the inbox", async () => {
  const msg = await send(root, AGENT, "sender", "test body");
  const inboxDir = join(root, AGENT, "inbox");
  const files = await list(inboxDir);

  expect(files).toHaveLength(1);
  expect(files[0]).toEndWith(".msg");

  const raw = await Bun.file(join(inboxDir, files[0])).json();
  expect(raw).toEqual(msg);
});

// --- list ---

test("list returns empty array for non-existent directory", async () => {
  const result = await list(join(root, "nonexistent"));
  expect(result).toEqual([]);
});

test("list returns only .msg files sorted", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  await Bun.file(join(inboxDir, "2-bbb.msg")).write("{}");
  await Bun.file(join(inboxDir, "1-aaa.msg")).write("{}");
  await Bun.file(join(inboxDir, "ignore.txt")).write("{}");

  const files = await list(inboxDir);
  expect(files).toEqual(["1-aaa.msg", "2-bbb.msg"]);
});

// --- read ---

test("read parses a valid message file", async () => {
  const msg = await send(root, AGENT, "sender", "read test");
  const inboxDir = join(root, AGENT, "inbox");
  const files = await list(inboxDir);

  const parsed = await read(inboxDir, files[0]);
  expect(parsed).toEqual(msg);
});

test("read throws on invalid message format", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  await Bun.file(join(inboxDir, "bad.msg")).write(JSON.stringify({ invalid: true }));

  expect(read(inboxDir, "bad.msg")).rejects.toThrow("Invalid message format");
});

// --- consume ---

test("consume reads and moves message to .processed", async () => {
  const msg = await send(root, AGENT, "sender", "consume test");
  const inboxDir = join(root, AGENT, "inbox");
  const files = await list(inboxDir);
  const filename = files[0];

  const result = await consume(inboxDir, filename);
  expect(result).toEqual(msg);

  // Original file should be gone
  const remaining = await list(inboxDir);
  expect(remaining).toEqual([]);

  // Should exist in .processed
  const processedFile = Bun.file(join(inboxDir, ".processed", filename));
  expect(await processedFile.exists()).toBe(true);
});

// --- quarantine ---

test("quarantine moves file to .unreadable", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  await Bun.file(join(inboxDir, "bad.msg")).write("not json");

  await quarantine(inboxDir, "bad.msg");

  // Original file should be gone
  expect(await Bun.file(join(inboxDir, "bad.msg")).exists()).toBe(false);

  // Should exist in .unreadable
  const unreadableFile = Bun.file(join(inboxDir, ".unreadable", "bad.msg"));
  expect(await unreadableFile.exists()).toBe(true);
  expect(await unreadableFile.text()).toBe("not json");
});
