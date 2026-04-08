import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxWatcher } from "./inbox-watcher";
import { AgentLogger } from "./logger";
import type { Message } from "./message";

let inbox: string;
let watcher: InboxWatcher;

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), "inbox-watcher-"));
  watcher = new InboxWatcher(inbox, { pollIntervalMs: 50 });
});

afterEach(async () => {
  watcher.stop();
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

test("emits message with filename when a valid .msg file appears", async () => {
  const received = new Promise<string>((resolve) => {
    watcher.on("message", (filename) => resolve(filename));
  });

  watcher.start();

  const msg: Message = { v: 1, id: "abc123", from: "test", ts: Date.now(), body: "hello" };
  await Bun.file(join(inbox, "123-abc.msg")).write(JSON.stringify(msg));

  const filename = await received;
  expect(filename).toBe("123-abc.msg");
});

test("does not move the file after emitting (consumer is responsible)", async () => {
  const received = new Promise<void>((resolve) => {
    watcher.on("message", () => resolve());
  });

  watcher.start();

  const msg: Message = { v: 1, id: "def456", from: "test", ts: Date.now(), body: "hi" };
  await Bun.file(join(inbox, "100-def.msg")).write(JSON.stringify(msg));

  await received;

  expect(existsSync(join(inbox, "100-def.msg"))).toBe(true);
  expect(existsSync(join(inbox, ".processed", "100-def.msg"))).toBe(false);
});

test("does not emit the same file twice", async () => {
  const filenames: string[] = [];
  watcher.on("message", (f) => filenames.push(f));

  watcher.start();

  const msg: Message = { v: 1, id: "dup1", from: "test", ts: Date.now(), body: "dup" };
  await Bun.file(join(inbox, "200-dup.msg")).write(JSON.stringify(msg));

  // Wait for several poll cycles
  await Bun.sleep(200);

  expect(filenames).toEqual(["200-dup.msg"]);
});

test("ignores non-.msg files", async () => {
  const messages: string[] = [];
  watcher.on("message", (f) => messages.push(f));

  watcher.start();

  await Bun.file(join(inbox, "notes.txt")).write("not a message");
  await Bun.sleep(150);

  expect(messages).toEqual([]);
});

test("emits error and quarantines invalid message files", async () => {
  const received = new Promise<Error>((resolve) => {
    watcher.on("error", (err) => resolve(err));
  });

  watcher.start();

  await Bun.file(join(inbox, "bad.msg")).write("not json");

  const err = await received;
  expect(err).toBeInstanceOf(Error);
  expect(existsSync(join(inbox, "bad.msg"))).toBe(false);
  expect(existsSync(join(inbox, ".unreadable", "bad.msg"))).toBe(true);
});

test("invalid file does not cause repeated errors", async () => {
  const errors: Error[] = [];
  watcher.on("error", (err) => errors.push(err));

  watcher.start();

  await Bun.file(join(inbox, "bad.msg")).write("not json");

  await Bun.sleep(200);

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

  for (const msg of msgs) {
    await Bun.file(join(inbox, `${msg.ts}-${msg.id}.msg`)).write(JSON.stringify(msg));
  }

  watcher.start();
  await allReceived;

  expect(filenames).toEqual(["1-a.msg", "2-b.msg", "3-c.msg"]);
});

test("re-emits a filename after it has been removed and a new file with the same name appears", async () => {
  const filenames: string[] = [];
  watcher.on("message", (f) => filenames.push(f));

  watcher.start();

  const msg: Message = { v: 1, id: "x1", from: "test", ts: 1, body: "a" };
  await Bun.file(join(inbox, "1-x.msg")).write(JSON.stringify(msg));
  await Bun.sleep(100);

  // Simulate consumer claiming the file (removes it from inbox)
  const { rename } = await import("node:fs/promises");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(inbox, ".in-progress"), { recursive: true });
  await rename(join(inbox, "1-x.msg"), join(inbox, ".in-progress", "1-x.msg"));
  await Bun.sleep(100);

  // Write the same filename again (edge case)
  await Bun.file(join(inbox, "1-x.msg")).write(JSON.stringify(msg));
  await Bun.sleep(100);

  expect(filenames).toEqual(["1-x.msg", "1-x.msg"]);
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

test("logs unreadable_message event when quarantining with a logger", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "inbox-watcher-log-"));
  const agentInbox = join(agentDir, "inbox");
  mkdirSync(agentInbox, { recursive: true });

  const logger = new AgentLogger(agentDir);
  const logWatcher = new InboxWatcher(agentInbox, { pollIntervalMs: 50, logger });

  const errReceived = new Promise<Error>((resolve) => {
    logWatcher.on("error", (err) => resolve(err));
  });

  logWatcher.start();

  await Bun.file(join(agentInbox, "bad.msg")).write("not json");

  await errReceived;
  logWatcher.stop();

  const logsDir = join(agentDir, "logs");
  const logFiles = readdirSync(logsDir).filter((f) => f.endsWith(".ndjson"));
  expect(logFiles).toHaveLength(1);

  const lines = readFileSync(join(logsDir, logFiles[0] as string), "utf8")
    .trim()
    .split("\n");
  expect(lines).toHaveLength(1);

  const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
  expect(entry.level).toBe("error");
  expect(entry.event).toBe("unreadable_message");
  expect(entry.file).toBe("bad.msg");
  expect(typeof entry.reason).toBe("string");

  rmSync(agentDir, { recursive: true, force: true });
});

test("quarantine works without a logger (no crash)", async () => {
  const received = new Promise<Error>((resolve) => {
    watcher.on("error", (err) => resolve(err));
  });

  watcher.start();
  await Bun.file(join(inbox, "bad2.msg")).write("not json");

  const err = await received;
  expect(err).toBeInstanceOf(Error);
  expect(existsSync(join(inbox, ".unreadable", "bad2.msg"))).toBe(true);
});
