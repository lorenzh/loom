import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InboxWatcher } from "./inbox-watcher";
import type { Message } from "./message";

let inbox: string;
let watcher: InboxWatcher;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), "inbox-watcher-"));
  watcher = new InboxWatcher(inbox, { pollIntervalMs: 50 });
});

afterEach(async () => {
  watcher.stop();
  // Allow any in-flight poll to settle before removing the directory.
  await Bun.sleep(10);
  rmSync(inbox, { recursive: true, force: true });
});

test("running is false before start", () => {
  expect(watcher.running).toBe(false);
});

test("running is true after start", () => {
  watcher.start();
  expect(watcher.running).toBe(true);
});

test("running is false after stop", () => {
  watcher.start();
  watcher.stop();
  expect(watcher.running).toBe(false);
});

test("stop is safe to call when not running", () => {
  expect(() => watcher.stop()).not.toThrow();
});

test("emits message with filename and parsed content for .msg files", async () => {
  const received = new Promise<{ filename: string; message: Message }>((resolve) => {
    watcher.on("message", (filename, message) => {
      resolve({ filename, message });
    });
  });

  watcher.start();

  const msg: Message = { v: 1, id: "abc123", from: "test", ts: Date.now(), body: "hello" };
  await Bun.file(join(inbox, "123-abc.msg")).write(JSON.stringify(msg));

  const event = await received;
  expect(event.filename).toBe("123-abc.msg");
  expect(event.message.id).toBe("abc123");
  expect(event.message.body).toBe("hello");
});

test("ignores non-.msg files", async () => {
  const messages: string[] = [];

  watcher.on("message", (filename) => {
    messages.push(filename);
  });

  watcher.start();

  await Bun.file(join(inbox, "notes.txt")).write("not a message");
  await Bun.sleep(150);

  expect(messages).toEqual([]);
});

test("inbox is set from constructor", () => {
  expect(watcher.inbox).toBe(inbox);
});

test("moves consumed messages to .processed/", async () => {
  const received = new Promise<void>((resolve) => {
    watcher.on("message", () => resolve());
  });

  watcher.start();

  const msg: Message = { v: 1, id: "def456", from: "test", ts: Date.now(), body: "hi" };
  await Bun.file(join(inbox, "100-def.msg")).write(JSON.stringify(msg));

  await received;

  expect(existsSync(join(inbox, "100-def.msg"))).toBe(false);
  expect(existsSync(join(inbox, ".processed", "100-def.msg"))).toBe(true);
});

test("emits error and quarantines invalid message files", async () => {
  const received = new Promise<Error>((resolve) => {
    watcher.on("error", (err) => resolve(err));
  });

  watcher.start();

  await Bun.file(join(inbox, "bad.msg")).write("not json");

  const err = await received;
  expect(err).toBeInstanceOf(Error);

  // File should be moved to .unreadable/, not left in inbox
  expect(existsSync(join(inbox, "bad.msg"))).toBe(false);
  expect(existsSync(join(inbox, ".unreadable", "bad.msg"))).toBe(true);
});

test("invalid file does not cause repeated errors", async () => {
  const errors: Error[] = [];
  watcher.on("error", (err) => errors.push(err));

  watcher.start();

  await Bun.file(join(inbox, "bad.msg")).write("not json");

  // Wait for several poll cycles
  await Bun.sleep(200);

  // Should only have errored once (file was quarantined on first encounter)
  expect(errors).toHaveLength(1);
});

test("processes messages in FIFO order (sorted by filename)", async () => {
  const filenames: string[] = [];
  const allReceived = new Promise<void>((resolve) => {
    watcher.on("message", (filename) => {
      filenames.push(filename);
      if (filenames.length === 3) resolve();
    });
  });

  const msgs = [
    { v: 1 as const, id: "a", from: "test", ts: 1, body: "first" },
    { v: 1 as const, id: "b", from: "test", ts: 2, body: "second" },
    { v: 1 as const, id: "c", from: "test", ts: 3, body: "third" },
  ];

  // Write files before starting so they're all picked up in one poll
  for (const msg of msgs) {
    await Bun.file(join(inbox, `${msg.ts}-${msg.id}.msg`)).write(JSON.stringify(msg));
  }

  watcher.start();
  await allReceived;

  expect(filenames).toEqual(["1-a.msg", "2-b.msg", "3-c.msg"]);
});

test("forAgent creates watcher for agent inbox path", () => {
  const agentWatcher = InboxWatcher.forAgent("/tmp/loom", "alice");
  expect(agentWatcher.inbox).toBe("/tmp/loom/alice/inbox");
  agentWatcher.stop();
});

test("pollIntervalMs defaults to 200", () => {
  const defaultWatcher = new InboxWatcher(inbox);
  expect(defaultWatcher.pollIntervalMs).toBe(200);
});
