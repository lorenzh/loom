/// <reference types="bun" />
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcess, list, read } from "@losoft/loom-runtime";
import { run } from "./run";

let loomHome: string;
const AGENT = "test-agent";
const ECHO_MODEL = "echo/test";

beforeEach(() => {
  loomHome = mkdtempSync(join(tmpdir(), "loom-home-"));
});

afterEach(() => {
  rmSync(loomHome, { recursive: true, force: true });
});

/** Replace process.stdin with a mock that yields `input`, restoring it after `fn` completes. */
async function withMockStdin(input: string, fn: () => Promise<void>): Promise<void> {
  const mockStdin = (async function* () {
    yield Buffer.from(input);
  })();
  const original = process.stdin;
  Object.defineProperty(process, "stdin", { value: mockStdin, writable: true, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "stdin", {
      value: original,
      writable: true,
      configurable: true,
    });
  }
}

/** Capture process.stdout.write calls during `fn`, returning the written strings. */
async function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = mock((...args: unknown[]) => {
    if (typeof args[0] === "string") written.push(args[0]);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return written;
}

// --- Arg validation ---

test("throws when agent name is missing", async () => {
  await expect(run(["--model", ECHO_MODEL], loomHome)).rejects.toThrow("Usage:");
});

test("throws when --model is missing", async () => {
  await expect(run([AGENT], loomHome)).rejects.toThrow("--model is required");
});

test("throws when both --system and --system-file are provided", async () => {
  const file = join(loomHome, "sys.txt");
  writeFileSync(file, "prompt");
  await expect(
    run([AGENT, "--model", ECHO_MODEL, "--system", "x", "--system-file", file], loomHome),
  ).rejects.toThrow("Cannot use both --system and --system-file");
});

// --- Agent directory creation ---

test("creates agent directory with expected structure", async () => {
  await withMockStdin("hello", () => run([AGENT, "--model", ECHO_MODEL, "--stdin"], loomHome));

  const agentDir = join(loomHome, "agents", AGENT);
  expect(existsSync(join(agentDir, "inbox"))).toBe(true);
  expect(existsSync(join(agentDir, "outbox"))).toBe(true);
  expect(existsSync(join(agentDir, "memory"))).toBe(true);
  expect(existsSync(join(agentDir, "logs"))).toBe(true);
  expect(existsSync(join(agentDir, "crashes"))).toBe(true);
  expect(existsSync(join(agentDir, "conversations"))).toBe(true);
});

test("writes model file", async () => {
  await withMockStdin("hi", () => run([AGENT, "--model", ECHO_MODEL, "--stdin"], loomHome));

  const agent = new AgentProcess(join(loomHome, "agents"), AGENT);
  expect(agent.model).toBe(ECHO_MODEL);
});

test("writes prompt.md when --system is provided", async () => {
  await withMockStdin("hi", () =>
    run([AGENT, "--model", ECHO_MODEL, "--stdin", "--system", "be helpful"], loomHome),
  );

  const promptFile = join(loomHome, "agents", AGENT, "prompt.md");
  expect(readFileSync(promptFile, "utf8")).toBe("be helpful");
});

test("writes prompt.md from --system-file", async () => {
  const sysFile = join(loomHome, "system.md");
  writeFileSync(sysFile, "from file");

  await withMockStdin("hi", () =>
    run([AGENT, "--model", ECHO_MODEL, "--stdin", "--system-file", sysFile], loomHome),
  );

  const promptFile = join(loomHome, "agents", AGENT, "prompt.md");
  expect(readFileSync(promptFile, "utf8")).toBe("from file");
});

// --- --stdin mode ---

test("--stdin processes message through full lifecycle and writes to stdout", async () => {
  const written = await captureStdout(() =>
    withMockStdin("echo this", () => run([AGENT, "--model", ECHO_MODEL, "--stdin"], loomHome)),
  );

  // Response written to stdout
  expect(written).toContain("echo this");

  // Message went through full lifecycle
  const inboxDir = join(loomHome, "agents", AGENT, "inbox");
  expect(await list(inboxDir)).toHaveLength(0);

  const outboxDir = join(loomHome, "agents", AGENT, "outbox");
  const outboxFiles = await list(outboxDir);
  expect(outboxFiles).toHaveLength(1);

  const reply = await read(outboxDir, outboxFiles[0]!);
  expect(reply.body).toBe("echo this");
});

test("--stdin sets shutdown state after completion", async () => {
  await captureStdout(() =>
    withMockStdin("hi", () => run([AGENT, "--model", ECHO_MODEL, "--stdin"], loomHome)),
  );

  const agent = new AgentProcess(join(loomHome, "agents"), AGENT);
  expect(agent.status).toBe("stopped");
  expect(agent.pid).toBeNull();
  expect(agent.stoppedAt).toBeTruthy();
});

test("--stdin ignores pre-existing inbox messages", async () => {
  // Plant a message in the inbox before running --stdin
  const { send: sendMsg } = await import("@losoft/loom-runtime");
  await sendMsg(join(loomHome, "agents"), AGENT, "old", "pre-existing message");

  const written = await captureStdout(() =>
    withMockStdin("new message", () => run([AGENT, "--model", ECHO_MODEL, "--stdin"], loomHome)),
  );

  // Only the stdin message should appear in stdout
  expect(written.join("")).toContain("new message");
  expect(written.join("")).not.toContain("pre-existing message");

  // Pre-existing message should still be in inbox (untouched)
  const inboxDir = join(loomHome, "agents", AGENT, "inbox");
  const remaining = await list(inboxDir);
  expect(remaining).toHaveLength(1);
});

test("--stdin throws on empty input", async () => {
  await withMockStdin("   ", async () => {
    await expect(run([AGENT, "--model", ECHO_MODEL, "--stdin"], loomHome)).rejects.toThrow(
      "No input received on stdin",
    );
  });
});

// --- Foreground mode ---

test("--prompt sends initial message to inbox", async () => {
  const runPromise = run([AGENT, "--model", ECHO_MODEL, "--prompt", "hello agent"], loomHome);

  // Wait for outbox reply to appear (message was processed)
  const outboxDir = join(loomHome, "agents", AGENT, "outbox");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const files = await list(outboxDir);
    if (files.length > 0) break;
    await new Promise<void>((r) => setTimeout(r, 10));
  }

  // Send SIGINT to trigger shutdown
  process.emit("SIGINT" as never);
  await runPromise;

  const agent = new AgentProcess(join(loomHome, "agents"), AGENT);
  expect(agent.status).toBe("stopped");

  const outboxFiles = await list(outboxDir);
  expect(outboxFiles).toHaveLength(1);
  const reply = await read(outboxDir, outboxFiles[0]!);
  expect(reply.body).toBe("hello agent");
});

test("foreground mode shuts down cleanly on SIGINT without --prompt", async () => {
  const runPromise = run([AGENT, "--model", ECHO_MODEL], loomHome);

  // Let the runner start polling
  await new Promise<void>((r) => setTimeout(r, 50));

  process.emit("SIGINT" as never);
  await runPromise;

  const agent = new AgentProcess(join(loomHome, "agents"), AGENT);
  expect(agent.status).toBe("stopped");
  expect(agent.pid).toBeNull();
  expect(agent.stoppedAt).toBeTruthy();
});
