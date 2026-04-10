import { join } from "node:path";
import { AgentProcess } from "@losoft/loom-runtime";

const SIGTERM_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

export interface StopOptions {
  /** How long to wait for SIGTERM before escalating to SIGKILL (default 10000ms). */
  sigtermTimeoutMs?: number;
}

/** Returns true if a process with the given PID is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` exits or `timeoutMs` elapses. Returns true if the process is dead. */
async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return !isAlive(pid);
}

/** Stop a specific agent. Sends SIGTERM; escalates to SIGKILL after timeout. */
export async function stop(args: string[], loomHome: string, options?: StopOptions): Promise<void> {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    throw new Error("Usage: loom agent stop <name>");
  }

  const agentsRoot = join(loomHome, "agents");
  const agent = new AgentProcess(agentsRoot, name);

  // Mark stopped immediately so the supervisor does not restart the agent
  agent.status = "stopped";
  agent.stoppedAt = new Date().toISOString();

  const pid = agent.pid;
  if (pid === null || !isAlive(pid)) {
    agent.pid = null;
    return;
  }

  process.kill(pid, "SIGTERM");

  const sigtermTimeout = options?.sigtermTimeoutMs ?? SIGTERM_TIMEOUT_MS;
  const died = await waitForDeath(pid, sigtermTimeout);

  if (!died) {
    process.kill(pid, "SIGKILL");
    await waitForDeath(pid, sigtermTimeout);
  }

  agent.pid = null;
}
