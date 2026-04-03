import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor, SupervisorAlreadyRunningError } from "./supervisor";

let home: string;
let supervisor: Supervisor | null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "supervisor-"));
  supervisor = null;
});

afterEach(async () => {
  await supervisor?.stop();
  rmSync(home, { recursive: true, force: true });
});

// --- PID file lifecycle ---

test("start writes PID file with current process PID", async () => {
  supervisor = new Supervisor({ loomHome: home });
  await supervisor.start();

  const pidPath = join(home, "supervisor.pid");
  expect(existsSync(pidPath)).toBe(true);
  const raw = await Bun.file(pidPath).text();
  expect(Number.parseInt(raw.trim(), 10)).toBe(process.pid);
});

test("stop removes PID file", async () => {
  supervisor = new Supervisor({ loomHome: home });
  await supervisor.start();
  await supervisor.stop();

  expect(existsSync(join(home, "supervisor.pid"))).toBe(false);
});

test("stop is idempotent", async () => {
  supervisor = new Supervisor({ loomHome: home });
  await supervisor.start();
  await supervisor.stop();
  await supervisor.stop(); // should not throw
});

// --- readPid ---

test("readPid returns null when no PID file exists", async () => {
  expect(await Supervisor.readPid(home)).toBeNull();
});

test("readPid returns PID from file", async () => {
  await Bun.write(join(home, "supervisor.pid"), "42\n");
  expect(await Supervisor.readPid(home)).toBe(42);
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

test("start cleans up stale PID file and proceeds", async () => {
  // Write a PID file for a process that does not exist
  await Bun.write(join(home, "supervisor.pid"), "4194304\n");

  supervisor = new Supervisor({ loomHome: home });
  await supervisor.start();

  const raw = await Bun.file(join(home, "supervisor.pid")).text();
  expect(Number.parseInt(raw.trim(), 10)).toBe(process.pid);
});

// --- single-instance enforcement ---

test("start throws SupervisorAlreadyRunningError when another supervisor is alive", async () => {
  // Write a PID file with the current process PID (which is alive)
  await Bun.write(join(home, "supervisor.pid"), `${process.pid}\n`);

  supervisor = new Supervisor({ loomHome: home });
  expect(supervisor.start()).rejects.toThrow(SupervisorAlreadyRunningError);
});
