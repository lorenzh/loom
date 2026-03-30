import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcess } from "./agent-process";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-process-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("creates agent directory on construction", () => {
  new AgentProcess(home, "alice");
  expect(existsSync(join(home, "alice"))).toBe(true);
});

test("name returns the agent name", () => {
  const agent = new AgentProcess(home, "alice");
  expect(agent.name).toBe("alice");
});

test("dir returns the agent directory path", () => {
  const agent = new AgentProcess(home, "alice");
  expect(agent.dir).toBe(join(home, "alice"));
});

test("pid defaults to null", () => {
  const agent = new AgentProcess(home, "alice");
  expect(agent.pid).toBeNull();
});

test("pid round-trips", () => {
  const agent = new AgentProcess(home, "alice");
  agent.pid = 12345;
  expect(agent.pid).toBe(12345);
});

test("pid can be set to null", () => {
  const agent = new AgentProcess(home, "alice");
  agent.pid = 42;
  agent.pid = null;
  expect(agent.pid).toBeNull();
});

test("status defaults to idle", () => {
  const agent = new AgentProcess(home, "alice");
  expect(agent.status).toBe("idle");
});

test("status round-trips", () => {
  const agent = new AgentProcess(home, "alice");
  agent.status = "running";
  expect(agent.status).toBe("running");
});

test("model defaults to unknown", () => {
  const agent = new AgentProcess(home, "alice");
  expect(agent.model).toBe("unknown");
});

test("model round-trips", () => {
  const agent = new AgentProcess(home, "alice");
  agent.model = "qwen2.5:7b";
  expect(agent.model).toBe("qwen2.5:7b");
});

test("startedAt defaults to null", () => {
  const agent = new AgentProcess(home, "alice");
  expect(agent.startedAt).toBeNull();
});

test("startedAt round-trips", () => {
  const agent = new AgentProcess(home, "alice");
  const ts = new Date().toISOString();
  agent.startedAt = ts;
  expect(agent.startedAt).toBe(ts);
});

test("stoppedAt defaults to null", () => {
  const agent = new AgentProcess(home, "alice");
  expect(agent.stoppedAt).toBeNull();
});

test("stoppedAt round-trips", () => {
  const agent = new AgentProcess(home, "alice");
  const ts = new Date().toISOString();
  agent.stoppedAt = ts;
  expect(agent.stoppedAt).toBe(ts);
});

test("files on disk use snake_case names", () => {
  const agent = new AgentProcess(home, "alice");
  agent.startedAt = "2026-01-01T00:00:00.000Z";
  agent.stoppedAt = "2026-01-01T01:00:00.000Z";

  expect(existsSync(join(home, "alice", "started_at"))).toBe(true);
  expect(existsSync(join(home, "alice", "stopped_at"))).toBe(true);
  expect(readFileSync(join(home, "alice", "started_at"), "utf8").trim()).toBe(
    "2026-01-01T00:00:00.000Z",
  );
});

test("entry returns full snapshot", () => {
  const agent = new AgentProcess(home, "alice");
  agent.pid = 99;
  agent.status = "running";
  agent.model = "anthropic/claude-sonnet-4-6";
  agent.startedAt = "2026-01-01T00:00:00.000Z";

  const entry = agent.entry;
  expect(entry.name).toBe("alice");
  expect(entry.pid).toBe(99);
  expect(entry.status).toBe("running");
  expect(entry.model).toBe("anthropic/claude-sonnet-4-6");
  expect(entry.startedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(entry.stoppedAt).toBeNull();
  expect(entry.dir).toBe(join(home, "alice"));
});

test("second AgentProcess for same name reads existing state", () => {
  const a1 = new AgentProcess(home, "alice");
  a1.status = "running";
  a1.pid = 42;

  const a2 = new AgentProcess(home, "alice");
  expect(a2.status).toBe("running");
  expect(a2.pid).toBe(42);
});
