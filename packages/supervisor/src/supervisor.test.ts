import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor, SupervisorAlreadyRunningError } from "./supervisor";

let home: string;
let supervisor: Supervisor | null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "supervisor-"));
  supervisor = null;
});

afterEach(() => {
  supervisor?.stop();
  rmSync(home, { recursive: true, force: true });
});

// --- PID file lifecycle ---

test("start writes PID file with current process PID", () => {
  supervisor = new Supervisor({ loomHome: home });
  supervisor.start();

  const pidPath = join(home, "supervisor.pid");
  expect(existsSync(pidPath)).toBe(true);
  const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
  expect(pid).toBe(process.pid);
});

test("stop removes PID file", () => {
  supervisor = new Supervisor({ loomHome: home });
  supervisor.start();
  supervisor.stop();

  expect(existsSync(join(home, "supervisor.pid"))).toBe(false);
});

test("stop is idempotent", () => {
  supervisor = new Supervisor({ loomHome: home });
  supervisor.start();
  supervisor.stop();
  supervisor.stop(); // should not throw
});

// --- readPid ---

test("readPid returns null when no PID file exists", () => {
  expect(Supervisor.readPid(home)).toBeNull();
});

test("readPid returns PID from file", () => {
  writeFileSync(join(home, "supervisor.pid"), "42\n", "utf8");
  expect(Supervisor.readPid(home)).toBe(42);
});

// --- isAlive ---

test("isAlive returns true for current process", () => {
  expect(Supervisor.isAlive(process.pid)).toBe(true);
});

test("isAlive returns false for non-existent PID", () => {
  // PID 4194304 is above Linux's default pid_max (4194304), so it cannot exist
  expect(Supervisor.isAlive(4194304)).toBe(false);
});

// --- stale PID detection ---

test("start cleans up stale PID file and proceeds", () => {
  // Write a PID file for a process that does not exist
  writeFileSync(join(home, "supervisor.pid"), "4194304\n", "utf8");

  supervisor = new Supervisor({ loomHome: home });
  supervisor.start();

  const pid = Number.parseInt(readFileSync(join(home, "supervisor.pid"), "utf8").trim(), 10);
  expect(pid).toBe(process.pid);
});

// --- single-instance enforcement ---

test("start throws SupervisorAlreadyRunningError when another supervisor is alive", () => {
  // Write a PID file with the current process PID (which is alive)
  writeFileSync(join(home, "supervisor.pid"), `${process.pid}\n`, "utf8");

  supervisor = new Supervisor({ loomHome: home });
  expect(() => supervisor!.start()).toThrow(SupervisorAlreadyRunningError);
});
