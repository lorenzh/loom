import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, atomicWriteSync } from "./atomic-write";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-write-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("atomicWriteSync creates a file with the expected content", () => {
  const target = join(dir, "test.txt");
  atomicWriteSync(target, "hello world");
  expect(readFileSync(target, "utf8")).toBe("hello world");
});

test("atomicWriteSync does not leave a .tmp file behind", () => {
  const target = join(dir, "clean.txt");
  atomicWriteSync(target, "data");
  const files = readdirSync(dir);
  expect(files).toEqual(["clean.txt"]);
});

test("atomicWriteSync overwrites an existing file atomically", () => {
  const target = join(dir, "overwrite.txt");
  atomicWriteSync(target, "v1");
  atomicWriteSync(target, "v2");
  expect(readFileSync(target, "utf8")).toBe("v2");
});

test("atomicWrite creates a file with the expected content", async () => {
  const target = join(dir, "async.txt");
  await atomicWrite(target, "async hello");
  expect(readFileSync(target, "utf8")).toBe("async hello");
});

test("atomicWrite does not leave a .tmp file behind", async () => {
  const target = join(dir, "async-clean.txt");
  await atomicWrite(target, "data");
  const files = readdirSync(dir);
  expect(files).toEqual(["async-clean.txt"]);
});
