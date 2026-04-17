import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, list, type Message, read } from "@losoft/loom-runtime";
import { type PipeConfig, PipeRunner } from "./pipe-runner";

let instanceDir: string;
let inboxDir: string;

beforeEach(async () => {
  instanceDir = await mkdtemp(join(tmpdir(), "pipe-runner-test-"));
  inboxDir = join(instanceDir, "inbox");
  await Bun.write(join(inboxDir, ".keep"), "");
});

afterEach(async () => {
  await rm(instanceDir, { recursive: true, force: true });
});

/** Write a message directly to the instance inbox. */
async function writeInbox(body: string, origin?: string): Promise<string> {
  const ts = Date.now();
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const filename = `${ts}-${id}.msg`;
  const msg: Message = { v: 1, id, from: "test-agent", ts, body, ...(origin ? { origin } : {}) };
  await atomicWrite(join(inboxDir, filename), JSON.stringify(msg, null, 2));
  return filename;
}

/** Poll until dir has at least count .msg files, or throw on timeout. */
async function waitForFiles(dir: string, count = 1, timeout = 2000): Promise<string[]> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const files = await readdir(dir).catch(() => [] as string[]);
    const msgs = files.filter((f) => f.endsWith(".msg"));
    if (msgs.length >= count) return msgs;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${count} .msg file(s) in ${dir}`);
}

/** Poll until inbox/.processed has at least one file. */
async function waitForProcessed(timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const files = await readdir(join(inboxDir, ".processed")).catch(() => [] as string[]);
    if (files.length > 0) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for message to be processed");
}

function makeRunner(config: PipeConfig): { runner: PipeRunner; runPromise: Promise<void> } {
  const runner = new PipeRunner(instanceDir, config, { pollIntervalMs: 20 });
  const runPromise = runner.run();
  return { runner, runPromise };
}

// ── Basic flow ────────────────────────────────────────────────────────────

test("passes message through a single command operator (cat) to outbox", async () => {
  await writeInbox('{"value":42}');

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "cat" }],
  });

  const outboxFiles = await waitForFiles(join(instanceDir, "outbox"));
  runner.stop();
  await runPromise;

  expect(outboxFiles).toHaveLength(1);
  const msg = await read(join(instanceDir, "outbox"), outboxFiles[0]!);
  expect(msg.body).toBe('{"value":42}');
  expect(msg.from).toBe(instanceDir.split("/").pop());
  expect(msg.v).toBe(1);
});

test("writes intermediate result to steps/0/", async () => {
  await writeInbox("hello");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "cat" }],
  });

  await waitForFiles(join(instanceDir, "outbox"));
  runner.stop();
  await runPromise;

  const stepFiles = await readdir(join(instanceDir, "steps", "0")).catch(() => [] as string[]);
  expect(stepFiles.filter((f) => f.endsWith(".msg"))).toHaveLength(1);

  const stepMsg = await read(
    join(instanceDir, "steps", "0"),
    stepFiles.filter((f) => f.endsWith(".msg"))[0]!,
  );
  expect(stepMsg.body).toBe("hello");
});

test("chains two operators and writes steps for each", async () => {
  await writeInbox("hello world");

  const { runner, runPromise } = makeRunner({
    operators: [
      { operator: "command", cmd: "cat" }, // step 0: echo through
      { operator: "command", cmd: "tr a-z A-Z" }, // step 1: uppercase
    ],
  });

  await waitForFiles(join(instanceDir, "outbox"));
  runner.stop();
  await runPromise;

  const outboxFiles = await waitForFiles(join(instanceDir, "outbox"));
  const msg = await read(join(instanceDir, "outbox"), outboxFiles[0]!);
  expect(msg.body).toBe("HELLO WORLD");

  const step0 = await readdir(join(instanceDir, "steps", "0"));
  const step1 = await readdir(join(instanceDir, "steps", "1"));
  expect(step0.filter((f) => f.endsWith(".msg"))).toHaveLength(1);
  expect(step1.filter((f) => f.endsWith(".msg"))).toHaveLength(1);
});

// ── Drop semantics ────────────────────────────────────────────────────────

test("drops message when command exits non-zero — no outbox, message acknowledged", async () => {
  await writeInbox("{}");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "exit 1" }],
  });

  await waitForProcessed();
  runner.stop();
  await runPromise;

  const outboxFiles = await readdir(join(instanceDir, "outbox")).catch(() => [] as string[]);
  expect(outboxFiles.filter((f) => f.endsWith(".msg"))).toHaveLength(0);

  const processed = await readdir(join(inboxDir, ".processed"));
  expect(processed).toHaveLength(1);
});

test("drops message when command produces no output", async () => {
  await writeInbox("{}");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "true" }], // exits 0 but no stdout
  });

  await waitForProcessed();
  runner.stop();
  await runPromise;

  const outboxFiles = await readdir(join(instanceDir, "outbox")).catch(() => [] as string[]);
  expect(outboxFiles.filter((f) => f.endsWith(".msg"))).toHaveLength(0);
});

test("short-circuits chain on first drop — does not run subsequent operators", async () => {
  await writeInbox("{}");

  const _op1Ran = false;
  const { runner, runPromise } = makeRunner({
    operators: [
      { operator: "command", cmd: "exit 1" }, // drops
      { operator: "command", cmd: "echo ran" }, // should not run
    ],
  });

  await waitForProcessed();
  runner.stop();
  await runPromise;

  // If step 1 directory exists with messages, op1 ran (it shouldn't)
  const step1Files = await readdir(join(instanceDir, "steps", "1")).catch(() => [] as string[]);
  expect(step1Files.filter((f) => f.endsWith(".msg"))).toHaveLength(0);
});

// ── Multi-line output (fan-out) ───────────────────────────────────────────

test("produces one outbox message per stdout line", async () => {
  await writeInbox("input");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: 'printf "line1\\nline2\\nline3"' }],
  });

  const outboxFiles = await waitForFiles(join(instanceDir, "outbox"), 3);
  runner.stop();
  await runPromise;

  expect(outboxFiles).toHaveLength(3);
});

// ── Origin propagation ────────────────────────────────────────────────────

test("prepends incoming filename to origin on outbox message", async () => {
  const filename = await writeInbox("test", "upstream-ts-abc.msg");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "cat" }],
  });

  const outboxFiles = await waitForFiles(join(instanceDir, "outbox"));
  runner.stop();
  await runPromise;

  const msg = await read(join(instanceDir, "outbox"), outboxFiles[0]!);
  expect(msg.origin).toBe(`upstream-ts-abc.msg/${filename}`);
});

test("sets origin from filename when incoming message has no origin", async () => {
  const filename = await writeInbox("no-origin-msg");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "cat" }],
  });

  const outboxFiles = await waitForFiles(join(instanceDir, "outbox"));
  runner.stop();
  await runPromise;

  const msg = await read(join(instanceDir, "outbox"), outboxFiles[0]!);
  expect(msg.origin).toBe(filename);
});

// ── Status file ───────────────────────────────────────────────────────────

test("writes idle to status file after processing", async () => {
  await writeInbox("{}");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "cat" }],
  });

  await waitForFiles(join(instanceDir, "outbox"));
  runner.stop();
  await runPromise;

  const status = await Bun.file(join(instanceDir, "status")).text();
  expect(status).toBe("idle");
});

// ── Inbox lifecycle ───────────────────────────────────────────────────────

test("moves processed message out of inbox", async () => {
  await writeInbox("{}");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "cat" }],
  });

  await waitForFiles(join(instanceDir, "outbox"));
  runner.stop();
  await runPromise;

  const remaining = await list(inboxDir);
  expect(remaining).toHaveLength(0);

  const processed = await readdir(join(inboxDir, ".processed"));
  expect(processed).toHaveLength(1);
});

test("processes multiple messages sequentially", async () => {
  await writeInbox("first");
  await writeInbox("second");
  await writeInbox("third");

  const { runner, runPromise } = makeRunner({
    operators: [{ operator: "command", cmd: "cat" }],
  });

  await waitForFiles(join(instanceDir, "outbox"), 3);
  runner.stop();
  await runPromise;

  const outboxFiles = await readdir(join(instanceDir, "outbox"));
  expect(outboxFiles.filter((f) => f.endsWith(".msg"))).toHaveLength(3);
});
