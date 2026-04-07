import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledge,
  claim,
  consume,
  fail,
  isMessage,
  list,
  quarantine,
  read,
  recover,
  send,
  sendReply,
} from "./message";

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

  const raw = await Bun.file(join(inboxDir, files[0] as string)).json();
  expect(raw).toEqual(msg);
});

test("send creates inbox directory if it does not exist", async () => {
  const freshRoot = mkdtempSync(join(tmpdir(), "message-fresh-"));
  try {
    await send(freshRoot, "new-agent", "sender", "hello");
    const files = await list(join(freshRoot, "new-agent", "inbox"));
    expect(files).toHaveLength(1);
  } finally {
    rmSync(freshRoot, { recursive: true, force: true });
  }
});

test("sendReply creates outbox directory if it does not exist", async () => {
  const freshRoot = mkdtempSync(join(tmpdir(), "message-fresh-"));
  try {
    await sendReply(freshRoot, "new-agent", "reply", "origin.msg");
    const files = await list(join(freshRoot, "new-agent", "outbox"));
    expect(files).toHaveLength(1);
  } finally {
    rmSync(freshRoot, { recursive: true, force: true });
  }
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

  const parsed = await read(inboxDir, files[0] as string);
  expect(parsed).toEqual(msg);
});

test("read throws on invalid message format", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  await Bun.file(join(inboxDir, "bad.msg")).write(JSON.stringify({ invalid: true }));

  expect(read(inboxDir, "bad.msg")).rejects.toThrow("Invalid message format");
});

// --- claim ---

test("claim reads message and moves it to .in-progress", async () => {
  const msg = await send(root, AGENT, "sender", "claim test");
  const inboxDir = join(root, AGENT, "inbox");
  const files = await list(inboxDir);
  const filename = files[0] as string;

  const result = await claim(inboxDir, filename);
  expect(result).toEqual(msg);

  // Original file should be gone from inbox
  const remaining = await list(inboxDir);
  expect(remaining).toEqual([]);

  // Should exist in .in-progress
  const inProgressFile = Bun.file(join(inboxDir, ".in-progress", filename));
  expect(await inProgressFile.exists()).toBe(true);
});

// --- acknowledge ---

test("acknowledge moves message from .in-progress to .processed", async () => {
  await send(root, AGENT, "sender", "ack test");
  const inboxDir = join(root, AGENT, "inbox");
  const files = await list(inboxDir);
  const filename = files[0] as string;

  // First claim it
  await claim(inboxDir, filename);

  // Then acknowledge it
  await acknowledge(inboxDir, filename);

  // Should not exist in .in-progress
  expect(await Bun.file(join(inboxDir, ".in-progress", filename)).exists()).toBe(false);

  // Should exist in .processed
  const processedFile = Bun.file(join(inboxDir, ".processed", filename));
  expect(await processedFile.exists()).toBe(true);
});

// --- consume ---

test("consume reads and moves message to .processed", async () => {
  const msg = await send(root, AGENT, "sender", "consume test");
  const inboxDir = join(root, AGENT, "inbox");
  const files = await list(inboxDir);
  const filename = files[0] as string;

  const result = await consume(inboxDir, filename);
  expect(result).toEqual(msg);

  // Original file should be gone
  const remaining = await list(inboxDir);
  expect(remaining).toEqual([]);

  // Should exist in .processed
  const processedFile = Bun.file(join(inboxDir, ".processed", filename));
  expect(await processedFile.exists()).toBe(true);
});

// --- sendReply ---

test("sendReply writes outbox message with origin", async () => {
  const outboxDir = join(root, AGENT, "outbox");

  const msg = await sendReply(root, AGENT, "reply body", "1234-abcd.msg");

  expect(msg.origin).toBe("1234-abcd.msg");
  expect(msg.from).toBe(AGENT);
  expect(msg.body).toBe("reply body");

  const files = await list(outboxDir);
  expect(files).toHaveLength(1);
  const raw = await Bun.file(join(outboxDir, files[0] as string)).json();
  expect(raw.origin).toBe("1234-abcd.msg");
});

test("sendReply writes outbox message with error flag", async () => {
  const outboxDir = join(root, AGENT, "outbox");

  const msg = await sendReply(root, AGENT, "timeout", "1234-abcd.msg", true);

  expect(msg.origin).toBe("1234-abcd.msg");
  expect(msg.error).toBe(true);

  const files = await list(outboxDir);
  const raw = await Bun.file(join(outboxDir, files[0] as string)).json();
  expect(raw.error).toBe(true);
});

// --- isMessage with origin and error ---

test("isMessage accepts message with origin", () => {
  expect(
    isMessage({
      v: 1,
      id: "abc",
      from: "sender",
      ts: 123,
      body: "hello",
      origin: "1234-abcd.msg",
    }),
  ).toBe(true);
});

test("isMessage accepts message with origin and error", () => {
  expect(
    isMessage({
      v: 1,
      id: "abc",
      from: "sender",
      ts: 123,
      body: "fail",
      origin: "1234-abcd.msg",
      error: true,
    }),
  ).toBe(true);
});

test("isMessage rejects message with non-string origin", () => {
  expect(isMessage({ v: 1, id: "abc", from: "sender", ts: 123, body: "hello", origin: 42 })).toBe(
    false,
  );
});

test("isMessage rejects message with non-boolean error", () => {
  expect(isMessage({ v: 1, id: "abc", from: "sender", ts: 123, body: "hello", error: "yes" })).toBe(
    false,
  );
});

// --- fail ---

test("fail moves message from .in-progress to .failed", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  await send(root, AGENT, "sender", "fail test");
  const files = await list(inboxDir);
  const filename = files[0] as string;

  await claim(inboxDir, filename);
  await fail(inboxDir, filename, {
    ts: new Date().toISOString(),
    attempts: 3,
    last_error: "timeout",
    error_type: "TimeoutError",
  });

  // Should not exist in .in-progress
  expect(await Bun.file(join(inboxDir, ".in-progress", filename)).exists()).toBe(false);

  // Should exist in .failed
  expect(await Bun.file(join(inboxDir, ".failed", filename)).exists()).toBe(true);
});

test("fail writes companion .error.json", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  await send(root, AGENT, "sender", "fail test");
  const files = await list(inboxDir);
  const filename = files[0] as string;

  await claim(inboxDir, filename);
  const errorInfo = {
    ts: "2026-01-01T00:00:00.000Z",
    attempts: 2,
    last_error: "network error",
    error_type: "NetworkError",
  };
  await fail(inboxDir, filename, errorInfo);

  const errorFile = Bun.file(join(inboxDir, ".failed", `${filename}.error.json`));
  expect(await errorFile.exists()).toBe(true);
  const parsed = await errorFile.json();
  expect(parsed).toEqual(errorInfo);
});

// --- recover ---

test("recover is a no-op when .in-progress is empty", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  const outboxDir = join(root, AGENT, "outbox");
  mkdirSync(outboxDir, { recursive: true });

  await recover(inboxDir, outboxDir); // should not throw
});

test("recover acknowledges an in-progress message whose reply origin ends with its filename", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  const outboxDir = join(root, AGENT, "outbox");
  mkdirSync(outboxDir, { recursive: true });

  await send(root, AGENT, "user", "hello");
  const files = await list(inboxDir);
  const filename = files[0]!;

  await claim(inboxDir, filename);
  await sendReply(root, AGENT, "reply", filename);

  await recover(inboxDir, outboxDir);

  expect(await Bun.file(join(inboxDir, ".in-progress", filename)).exists()).toBe(false);
  expect(await Bun.file(join(inboxDir, ".processed", filename)).exists()).toBe(true);
  expect(await list(inboxDir)).toHaveLength(0);
});

test("recover moves an in-progress message back to inbox when no reply exists", async () => {
  const inboxDir = join(root, AGENT, "inbox");
  const outboxDir = join(root, AGENT, "outbox");
  mkdirSync(outboxDir, { recursive: true });

  await send(root, AGENT, "user", "hello");
  const files = await list(inboxDir);
  const filename = files[0]!;

  await claim(inboxDir, filename);

  await recover(inboxDir, outboxDir);

  expect(await Bun.file(join(inboxDir, ".in-progress", filename)).exists()).toBe(false);
  expect(await list(inboxDir)).toEqual([filename]);
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
