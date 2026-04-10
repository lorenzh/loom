/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcess } from "@losoft/loom-runtime";
import { stop } from "./stop";

let loomHome: string;
const AGENT = "test-agent";

beforeEach(() => {
  loomHome = mkdtempSync(join(tmpdir(), "loom-home-"));
});

afterEach(() => {
  rmSync(loomHome, { recursive: true, force: true });
});

// ── arg validation ────────────────────────────────────────────────────────────

test("throws when agent name is missing", async () => {
  await expect(stop([], loomHome)).rejects.toThrow("Usage:");
});

// ── no running process ────────────────────────────────────────────────────────

test("marks status stopped when agent has no PID", async () => {
  const agentsRoot = join(loomHome, "agents");
  const agent = new AgentProcess(agentsRoot, AGENT);
  agent.status = "idle";

  await stop([AGENT], loomHome);

  expect(agent.status).toBe("stopped");
  expect(agent.stoppedAt).toBeTruthy();
  expect(agent.pid).toBeNull();
});

test("marks status stopped when PID points to a dead process", async () => {
  const agentsRoot = join(loomHome, "agents");
  const agent = new AgentProcess(agentsRoot, AGENT);
  agent.pid = 999_999_999; // almost certainly not a real PID

  await stop([AGENT], loomHome);

  expect(agent.status).toBe("stopped");
  expect(agent.pid).toBeNull();
});

// ── SIGTERM ───────────────────────────────────────────────────────────────────

test("sends SIGTERM and waits for process to exit", async () => {
  // Spawn a long-running process
  const proc = Bun.spawn(["/usr/bin/sleep", "60"]);
  const pid = proc.pid;

  const agentsRoot = join(loomHome, "agents");
  const agent = new AgentProcess(agentsRoot, AGENT);
  agent.pid = pid;
  agent.status = "running";

  await stop([AGENT], loomHome, { sigtermTimeoutMs: 2000 });

  expect(agent.status).toBe("stopped");
  expect(agent.pid).toBeNull();
  expect(agent.stoppedAt).toBeTruthy();

  // Verify the process is actually dead
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
});

// ── SIGKILL escalation ────────────────────────────────────────────────────────

test("escalates to SIGKILL when process ignores SIGTERM", async () => {
  // Spawn a shell that traps and ignores SIGTERM
  const proc = Bun.spawn([
    "/usr/bin/bash",
    "-c",
    "trap '' TERM; while true; do /usr/bin/sleep 0.1; done",
  ]);
  const pid = proc.pid;

  // Give the shell a moment to set up the trap
  await new Promise<void>((r) => setTimeout(r, 100));

  const agentsRoot = join(loomHome, "agents");
  const agent = new AgentProcess(agentsRoot, AGENT);
  agent.pid = pid;
  agent.status = "running";

  // Use a short SIGTERM timeout so the test doesn't take 10 seconds
  await stop([AGENT], loomHome, { sigtermTimeoutMs: 300 });

  expect(agent.status).toBe("stopped");
  expect(agent.pid).toBeNull();

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
});
