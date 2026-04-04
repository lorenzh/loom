/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list, read } from "@losoft/loom-runtime";
import { send } from "./send";

let loomHome: string;
const AGENT = "test-agent";

beforeEach(() => {
  loomHome = mkdtempSync(join(tmpdir(), "loom-home-"));
});

afterEach(() => {
  rmSync(loomHome, { recursive: true, force: true });
});

test("send writes a message with args", async () => {
  await send([AGENT, "hello from args"], loomHome);

  const inboxDir = join(loomHome, "agents", AGENT, "inbox");
  const files = await list(inboxDir);
  expect(files).toHaveLength(1);

  const msg = await read(inboxDir, files[0]!);
  expect(msg.from).toBe("cli");
  expect(msg.body).toBe("hello from args");
});

test("send writes a message with --stdin", async () => {
  const originalStdin = process.stdin;

  // Mock process.stdin as an async iterable that yields one chunk
  const mockStdin = (async function* () {
    yield Buffer.from("hello from stdin");
  })();

  Object.defineProperty(process, "stdin", {
    value: mockStdin,
    writable: true,
    configurable: true,
  });

  try {
    await send([AGENT, "--stdin"], loomHome);
  } finally {
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  }

  const inboxDir = join(loomHome, "agents", AGENT, "inbox");
  const files = await list(inboxDir);
  expect(files).toHaveLength(1);

  const msg = await read(inboxDir, files[0]!);
  expect(msg.from).toBe("cli");
  expect(msg.body).toBe("hello from stdin");
});
