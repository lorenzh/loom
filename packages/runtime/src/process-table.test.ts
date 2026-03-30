import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessTable } from "./process-table";

let home: string;
let table: ProcessTable;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "process-table-"));
  table = new ProcessTable(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("get creates agent directory and returns AgentProcess", () => {
  const agent = table.get("alice");
  expect(agent.name).toBe("alice");
  expect(existsSync(join(home, "alice"))).toBe(true);
});

test("get same name twice returns consistent state", () => {
  const a1 = table.get("alice");
  a1.status = "running";
  a1.pid = 42;

  const a2 = table.get("alice");
  expect(a2.status).toBe("running");
  expect(a2.pid).toBe(42);
});

test("has returns false for unknown agent", () => {
  expect(table.has("unknown")).toBe(false);
});

test("has returns true for existing agent", () => {
  table.get("alice");
  expect(table.has("alice")).toBe(true);
});

test("agents lists all agent directories", () => {
  table.get("alice");
  table.get("bob");
  table.get("carol");

  const agents = table.agents().sort();
  expect(agents).toEqual(["alice", "bob", "carol"]);
});

test("agents returns empty array when home does not exist", () => {
  const empty = new ProcessTable(join(home, "nonexistent"));
  expect(empty.agents()).toEqual([]);
});

test("entries returns snapshots for all agents", () => {
  const alice = table.get("alice");
  alice.status = "running";
  alice.model = "qwen2.5:7b";

  const bob = table.get("bob");
  bob.status = "idle";

  const entries = table.entries();
  expect(entries).toHaveLength(2);

  const aliceEntry = entries.find((e) => e.name === "alice");
  expect(aliceEntry?.status).toBe("running");
  expect(aliceEntry?.model).toBe("qwen2.5:7b");

  const bobEntry = entries.find((e) => e.name === "bob");
  expect(bobEntry?.status).toBe("idle");
});

test("remove deletes agent directory", () => {
  table.get("alice");
  expect(table.has("alice")).toBe(true);

  table.remove("alice");
  expect(table.has("alice")).toBe(false);
  expect(existsSync(join(home, "alice"))).toBe(false);
});

test("remove is safe for non-existent agent", () => {
  expect(() => table.remove("unknown")).not.toThrow();
});

test("state round-trip through entries", () => {
  const agent = table.get("alice");
  agent.pid = 123;
  agent.status = "running";
  agent.model = "anthropic/claude-sonnet-4-6";
  agent.startedAt = "2026-03-25T12:00:00.000Z";

  const [entry] = table.entries();
  expect(entry?.pid).toBe(123);
  expect(entry?.status).toBe("running");
  expect(entry?.model).toBe("anthropic/claude-sonnet-4-6");
  expect(entry?.startedAt).toBe("2026-03-25T12:00:00.000Z");
  expect(entry?.stoppedAt).toBeNull();
});
