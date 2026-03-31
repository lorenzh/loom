import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentLogger } from "./logger";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "logger-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

test("log creates logs/ directory on first write", () => {
  const logger = new AgentLogger(agentDir);
  logger.info("test.event");
  expect(existsSync(join(agentDir, "logs"))).toBe(true);
});

test("log writes a valid NDJSON line", () => {
  const logger = new AgentLogger(agentDir);
  logger.info("agent.started", { pid: 42 });

  const logsDir = join(agentDir, "logs");
  const files = existsSync(logsDir)
    ? require("node:fs").readdirSync(logsDir).filter((f: string) => f.endsWith(".ndjson"))
    : [];
  expect(files).toHaveLength(1);

  const content = readFileSync(join(logsDir, files[0]), "utf8");
  const lines = content.trim().split("\n");
  expect(lines).toHaveLength(1);

  const entry = JSON.parse(lines[0]);
  expect(entry.level).toBe("info");
  expect(entry.event).toBe("agent.started");
  expect(entry.pid).toBe(42);
  expect(typeof entry.ts).toBe("string");
});

test("log filename is based on the current date", () => {
  const logger = new AgentLogger(agentDir);
  logger.warn("test.warn");

  const logsDir = join(agentDir, "logs");
  const files = require("node:fs").readdirSync(logsDir);
  expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.ndjson$/);
});

test("multiple log calls append to the same file", () => {
  const logger = new AgentLogger(agentDir);
  logger.info("first.event");
  logger.error("second.event", { reason: "crash" });

  const logsDir = join(agentDir, "logs");
  const files = require("node:fs").readdirSync(logsDir);
  const content = readFileSync(join(logsDir, files[0]), "utf8");
  const lines = content.trim().split("\n");

  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]).event).toBe("first.event");
  expect(JSON.parse(lines[1]).event).toBe("second.event");
  expect(JSON.parse(lines[1]).reason).toBe("crash");
});

test("convenience methods set the correct level", () => {
  const logger = new AgentLogger(agentDir);
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");

  const logsDir = join(agentDir, "logs");
  const files = require("node:fs").readdirSync(logsDir);
  const lines = readFileSync(join(logsDir, files[0]), "utf8")
    .trim()
    .split("\n")
    .map((l: string) => JSON.parse(l));

  expect(lines[0].level).toBe("debug");
  expect(lines[1].level).toBe("info");
  expect(lines[2].level).toBe("warn");
  expect(lines[3].level).toBe("error");
});
