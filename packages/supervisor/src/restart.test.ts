import { describe, expect, test } from "bun:test";
import { computeBackoff, isMaxRestartsExceeded } from "./restart";

describe("computeBackoff", () => {
  test("restartCount 0 returns value between 1000-1500ms", () => {
    const result = computeBackoff(0);
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThanOrEqual(1500);
  });

  test("caps at maxBackoffMs for high restart counts", () => {
    const result = computeBackoff(20);
    expect(result).toBeGreaterThanOrEqual(300000);
    expect(result).toBeLessThanOrEqual(300500);
  });

  test("jitter is between 0-500ms", () => {
    for (let i = 0; i < 50; i++) {
      const result = computeBackoff(0);
      const jitter = result - 1000;
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThanOrEqual(500);
    }
  });
});

describe("isMaxRestartsExceeded", () => {
  test("returns false when restartCount < 10", () => {
    expect(isMaxRestartsExceeded(0)).toBe(false);
    expect(isMaxRestartsExceeded(5)).toBe(false);
    expect(isMaxRestartsExceeded(9)).toBe(false);
  });

  test("returns true when restartCount >= 10", () => {
    expect(isMaxRestartsExceeded(10)).toBe(true);
    expect(isMaxRestartsExceeded(15)).toBe(true);
  });
});
