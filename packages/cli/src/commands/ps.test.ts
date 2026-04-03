import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcess } from "@losoft/loom-runtime";
import { ps } from "./ps";

let home: string;
let logs: string[];
const originalLog = console.log;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cli-ps-"));
  logs = [];
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
});

afterEach(() => {
  console.log = originalLog;
  rmSync(home, { recursive: true, force: true });
});

test("ps prints 'No agents found.' when no agents exist", async () => {
  await ps([], home);
  expect(logs).toEqual(["No agents found."]);
});

test("ps lists agents in a table", async () => {
  const agentsDir = join(home, "agents");
  const alice = new AgentProcess(agentsDir, "alice");
  alice.status = "running";
  alice.model = "ollama/llama3";
  alice.pid = 1234;

  const bob = new AgentProcess(agentsDir, "bob");
  bob.status = "idle";
  bob.model = "anthropic/claude-sonnet";

  await ps([], home);

  expect(logs.length).toBe(3); // header + 2 rows
  expect(logs[0]).toContain("NAME");
  expect(logs[0]).toContain("STATUS");
  expect(logs[0]).toContain("MODEL");
  expect(logs[0]).toContain("PID");

  const output = logs.join("\n");
  expect(output).toContain("alice");
  expect(output).toContain("running");
  expect(output).toContain("ollama/llama3");
  expect(output).toContain("1234");
  expect(output).toContain("bob");
  expect(output).toContain("idle");
});

test("ps --json outputs JSON array", async () => {
  const agentsDir = join(home, "agents");
  const alice = new AgentProcess(agentsDir, "alice");
  alice.status = "running";
  alice.model = "ollama/llama3";
  alice.pid = 42;

  await ps(["--json"], home);

  const parsed = JSON.parse(logs.join(""));
  expect(parsed).toBeArray();
  expect(parsed).toHaveLength(1);
  expect(parsed[0].name).toBe("alice");
  expect(parsed[0].status).toBe("running");
  expect(parsed[0].model).toBe("ollama/llama3");
  expect(parsed[0].pid).toBe(42);
});

test("ps --json outputs empty array when no agents exist", async () => {
  await ps(["--json"], home);

  const parsed = JSON.parse(logs.join(""));
  expect(parsed).toEqual([]);
});
