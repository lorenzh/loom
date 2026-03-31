import { afterEach, beforeEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loomHome } from "./env";

let original: string | undefined;

beforeEach(() => {
  original = process.env.LOOM_HOME;
});

afterEach(() => {
  if (original === undefined) {
    delete process.env.LOOM_HOME;
  } else {
    process.env.LOOM_HOME = original;
  }
});

test("returns LOOM_HOME when set", () => {
  process.env.LOOM_HOME = "/custom/loom";
  expect(loomHome()).toBe("/custom/loom");
});

test("falls back to ~/.loom when LOOM_HOME is unset", () => {
  delete process.env.LOOM_HOME;
  expect(loomHome()).toBe(join(homedir(), ".loom"));
});
