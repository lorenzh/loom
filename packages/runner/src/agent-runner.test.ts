import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcess, claim, list, read, send, sendReply } from "@losoft/loom-runtime";
import { AgentRunner } from "./agent-runner";
import { type Provider, ProviderRegistry } from "./provider";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "loom-runner-test-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function makeRegistry(response: string): ProviderRegistry {
  const registry = new ProviderRegistry();
  const provider: Provider = { chat: async () => ({ text: response }) };
  registry.register("ollama", provider);
  return registry;
}

/** Poll until outboxDir has at least one .msg file, or throw on timeout. */
async function waitForOutbox(outboxDir: string, timeout = 2000): Promise<string[]> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const files = await list(outboxDir);
    if (files.length > 0) return files;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for outbox message");
}

/** Poll until the agent's status file matches the expected value. */
async function waitForStatus(agent: AgentProcess, status: string, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (agent.status === status) return;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for status "${status}" (current: "${agent.status}")`);
}

const AGENT = "alice";

test("processes a message end-to-end and writes outbox reply", async () => {
  const agent = new AgentProcess(home, AGENT);
  agent.model = "ollama/llama3";

  await send(home, AGENT, "user", "hello");

  const runner = new AgentRunner(home, AGENT, makeRegistry("world"), { pollIntervalMs: 20 });
  const runPromise = runner.run();

  const outboxDir = join(home, AGENT, "outbox");
  const outboxFiles = await waitForOutbox(outboxDir);
  runner.stop();
  await runPromise;

  expect(outboxFiles).toHaveLength(1);
  const reply = await read(outboxDir, outboxFiles[0]!);
  expect(reply.body).toBe("world");
  expect(reply.from).toBe(AGENT);
});

test("reply includes in_reply_to referencing the inbox filename", async () => {
  new AgentProcess(home, AGENT);

  const inboxMsg = await send(home, AGENT, "user", "ping");

  const runner = new AgentRunner(home, AGENT, makeRegistry("pong"), { pollIntervalMs: 20 });
  const runPromise = runner.run();

  const outboxDir = join(home, AGENT, "outbox");
  const outboxFiles = await waitForOutbox(outboxDir);
  runner.stop();
  await runPromise;

  const reply = await read(outboxDir, outboxFiles[0]!);
  expect(reply.in_reply_to).toContain(inboxMsg.id);
});

test("message moves from inbox to .processed after handling", async () => {
  new AgentProcess(home, AGENT);
  await send(home, AGENT, "user", "test");

  const runner = new AgentRunner(home, AGENT, makeRegistry("ok"), { pollIntervalMs: 20 });
  const runPromise = runner.run();

  await waitForOutbox(join(home, AGENT, "outbox"));
  runner.stop();
  await runPromise;

  const inboxDir = join(home, AGENT, "inbox");
  expect(await list(inboxDir)).toHaveLength(0);

  const processedFiles = await readdir(join(inboxDir, ".processed"));
  expect(processedFiles.filter((f) => f.endsWith(".msg"))).toHaveLength(1);
});

test("status transitions idle -> running -> idle", async () => {
  let capturedStatusDuringChat: string | undefined;
  const registry = new ProviderRegistry();
  registry.register("ollama", {
    chat: async () => {
      capturedStatusDuringChat = agent.status;
      return { text: "reply" };
    },
  } satisfies Provider);

  const runner = new AgentRunner(home, AGENT, registry, { pollIntervalMs: 20 });
  const agent = new AgentProcess(home, AGENT); // shared filesystem state with runner's internal agent
  await send(home, AGENT, "user", "hi");
  const runPromise = runner.run();

  // Wait for the outbox reply to appear (chat was called), then wait for idle (acknowledge done)
  await waitForOutbox(join(home, AGENT, "outbox"));
  await waitForStatus(agent, "idle");
  runner.stop();
  await runPromise;

  expect(capturedStatusDuringChat).toBe("running");
  expect(agent.status).toBe("idle");
});

test("processes multiple messages in FIFO order", async () => {
  new AgentProcess(home, AGENT);
  await send(home, AGENT, "user", "first");
  await new Promise<void>((r) => setTimeout(r, 5)); // ensure different timestamps
  await send(home, AGENT, "user", "second");

  const received: string[] = [];
  const registry = new ProviderRegistry();
  registry.register("ollama", {
    chat: async (_model, _system, messages) => {
      received.push(messages[0]!.content);
      return { text: "ok" };
    },
  } satisfies Provider);

  const runner = new AgentRunner(home, AGENT, registry, { pollIntervalMs: 20 });
  const runPromise = runner.run();

  const outboxDir = join(home, AGENT, "outbox");
  // wait for both messages
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const files = await list(outboxDir);
    if (files.length >= 2) break;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  runner.stop();
  await runPromise;

  expect(received).toEqual(["first", "second"]);
});

test("messages arriving in the same poll cycle are processed sequentially, not concurrently", async () => {
  const starts: number[] = [];
  const ends: number[] = [];
  const registry = new ProviderRegistry();
  registry.register("ollama", {
    chat: async () => {
      starts.push(Date.now());
      await new Promise<void>((r) => setTimeout(r, 30)); // simulate slow LLM
      ends.push(Date.now());
      return { text: "ok" };
    },
  } satisfies Provider);

  // Create runner first (constructor creates inbox directory), then enqueue both messages
  // before calling run() so they land in the first poll cycle.
  const serialRunner = new AgentRunner(home, AGENT, registry, { pollIntervalMs: 20 });
  await send(home, AGENT, "user", "first");
  await send(home, AGENT, "user", "second");
  const runPromise = serialRunner.run();

  const outboxDir = join(home, AGENT, "outbox");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const files = await list(outboxDir);
    if (files.length >= 2) break;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  serialRunner.stop();
  await runPromise;

  // Second message must not start before first message ends
  expect(starts).toHaveLength(2);
  expect(ends).toHaveLength(2);
  expect(starts[1]!).toBeGreaterThanOrEqual(ends[0]!);
});

test("recover: skips already-replied in-progress message, no duplicate LLM call", async () => {
  new AgentProcess(home, AGENT);
  const inboxMsg = await send(home, AGENT, "user", "pre-crash");
  const inboxDir = join(home, AGENT, "inbox");
  const inboxFiles = await list(inboxDir);
  const filename = inboxFiles[0]!;

  // Simulate crash state: message was claimed and reply was written, but not acknowledged
  await claim(inboxDir, filename);
  await sendReply(home, AGENT, "pre-crash reply", filename);

  let callCount = 0;
  const registry = new ProviderRegistry();
  registry.register("ollama", {
    chat: async () => {
      callCount++;
      return { text: "should not be called" };
    },
  } satisfies Provider);

  const runner = new AgentRunner(home, AGENT, registry, { pollIntervalMs: 20 });
  const runPromise = runner.run();

  // Wait a couple of poll cycles then stop
  await new Promise<void>((r) => setTimeout(r, 80));
  runner.stop();
  await runPromise;

  expect(callCount).toBe(0);
  const outboxFiles = await list(join(home, AGENT, "outbox"));
  expect(outboxFiles).toHaveLength(1);
  const reply = await read(join(home, AGENT, "outbox"), outboxFiles[0]!);
  expect(reply.in_reply_to).toContain(inboxMsg.id);
  expect(await list(inboxDir)).toHaveLength(0);
});

test("recover: reprocesses in-progress message that has no outbox reply", async () => {
  new AgentProcess(home, AGENT);
  await send(home, AGENT, "user", "unfinished");
  const inboxDir = join(home, AGENT, "inbox");
  const inboxFiles = await list(inboxDir);
  const filename = inboxFiles[0]!;

  // Simulate crash state: message was claimed but runner crashed before writing the reply
  await claim(inboxDir, filename);

  const runner = new AgentRunner(home, AGENT, makeRegistry("recovered reply"), {
    pollIntervalMs: 20,
  });
  const runPromise = runner.run();

  const outboxDir = join(home, AGENT, "outbox");
  const outboxFiles = await waitForOutbox(outboxDir);
  runner.stop();
  await runPromise;

  expect(outboxFiles).toHaveLength(1);
  const reply = await read(outboxDir, outboxFiles[0]!);
  expect(reply.body).toBe("recovered reply");
  expect(await list(inboxDir)).toHaveLength(0);
});

test("stop() halts the polling loop", async () => {
  new AgentProcess(home, AGENT);

  const runner = new AgentRunner(home, AGENT, makeRegistry("x"), { pollIntervalMs: 20 });
  const runPromise = runner.run();
  runner.stop();
  await runPromise; // should resolve promptly

  // No messages were sent — outbox should be empty
  expect(await list(join(home, AGENT, "outbox"))).toHaveLength(0);
});
