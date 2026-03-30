import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InboxRouter } from "./inbox-router";
import type { Message } from "./message";

let home: string;
let router: InboxRouter;

function agentInbox(agent: string): string {
  const inbox = join(home, agent, "inbox");
  mkdirSync(inbox, { recursive: true });
  return inbox;
}

function makeMsg(overrides?: Partial<Message>): Message {
  return { v: 1, id: "test-id", from: "sender", ts: Date.now(), body: "hello", ...overrides };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inbox-router-"));
  router = new InboxRouter(home, { pollIntervalMs: 50 });
});

afterEach(async () => {
  router.stop();
  await Bun.sleep(10);
  rmSync(home, { recursive: true, force: true });
});

test("add registers an agent", () => {
  agentInbox("alice");
  router.add("alice");
  expect(router.has("alice")).toBe(true);
  expect(router.agents()).toEqual(["alice"]);
});

test("add is idempotent", () => {
  agentInbox("alice");
  router.add("alice");
  router.add("alice");
  expect(router.agents()).toEqual(["alice"]);
});

test("remove stops and cleans up", () => {
  agentInbox("alice");
  router.add("alice");
  router.remove("alice");
  expect(router.has("alice")).toBe(false);
  expect(router.agents()).toEqual([]);
});

test("remove is safe for unknown agent", () => {
  expect(() => router.remove("unknown")).not.toThrow();
});

test("stop clears all watchers", () => {
  agentInbox("alice");
  agentInbox("bob");
  router.add("alice");
  router.add("bob");
  router.stop();
  expect(router.agents()).toEqual([]);
});

test("emits message with agent name", async () => {
  const inbox = agentInbox("alice");

  const received = new Promise<{ agent: string; filename: string; message: Message }>((resolve) => {
    router.on("message", (agent, filename, message) => {
      resolve({ agent, filename, message });
    });
  });

  router.add("alice");

  const msg = makeMsg({ id: "msg-1" });
  await Bun.file(join(inbox, "100-msg1.msg")).write(JSON.stringify(msg));

  const event = await received;
  expect(event.agent).toBe("alice");
  expect(event.filename).toBe("100-msg1.msg");
  expect(event.message.id).toBe("msg-1");
});

test("emits error with agent name", async () => {
  const inbox = agentInbox("alice");

  const received = new Promise<{ agent: string; error: Error }>((resolve) => {
    router.on("error", (agent, error) => {
      resolve({ agent, error });
    });
  });

  router.add("alice");

  await Bun.file(join(inbox, "bad.msg")).write("not json");

  const event = await received;
  expect(event.agent).toBe("alice");
  expect(event.error).toBeInstanceOf(Error);
});

test("multiple agents emit independently", async () => {
  const aliceInbox = agentInbox("alice");
  const bobInbox = agentInbox("bob");

  const messages: { agent: string; id: string }[] = [];
  const allReceived = new Promise<void>((resolve) => {
    router.on("message", (agent, _filename, message) => {
      messages.push({ agent, id: message.id });
      if (messages.length === 2) resolve();
    });
  });

  router.add("alice");
  router.add("bob");

  await Bun.file(join(aliceInbox, "100-a.msg")).write(JSON.stringify(makeMsg({ id: "a1" })));
  await Bun.file(join(bobInbox, "100-b.msg")).write(JSON.stringify(makeMsg({ id: "b1" })));

  await allReceived;

  expect(messages).toContainEqual({ agent: "alice", id: "a1" });
  expect(messages).toContainEqual({ agent: "bob", id: "b1" });
});

test("removed agent no longer emits", async () => {
  const inbox = agentInbox("alice");

  router.add("alice");
  router.remove("alice");

  const messages: string[] = [];
  router.on("message", (agent) => messages.push(agent));

  await Bun.file(join(inbox, "100-x.msg")).write(JSON.stringify(makeMsg()));
  await Bun.sleep(150);

  expect(messages).toEqual([]);
});
