import { expect, test } from "bun:test";
import { ModelNotFoundError, ProviderAuthError, ToolCallParseError } from "./errors";
import { classifyError, type ErrorKind, RetryExhaustedError, withRetry } from "./retry";

// ── classifyError ─────────────────────────────────────────────────────────────

test("ProviderAuthError is permanent", () => {
  expect(classifyError(new ProviderAuthError("openai"))).toBe<ErrorKind>("permanent");
});

test("ModelNotFoundError is permanent", () => {
  expect(classifyError(new ModelNotFoundError("openai", "gpt-99"))).toBe<ErrorKind>("permanent");
});

test("ToolCallParseError is permanent", () => {
  expect(
    classifyError(new ToolCallParseError("myTool", "bad json", new SyntaxError())),
  ).toBe<ErrorKind>("permanent");
});

test("generic Error is transient", () => {
  expect(classifyError(new Error("network timeout"))).toBe<ErrorKind>("transient");
});

test("non-Error values are transient", () => {
  expect(classifyError("some string error")).toBe<ErrorKind>("transient");
  expect(classifyError(503)).toBe<ErrorKind>("transient");
});

// ── withRetry ─────────────────────────────────────────────────────────────────

test("resolves immediately when fn succeeds on first attempt", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return "ok";
    },
    3,
    0,
  );
  expect(result).toBe("ok");
  expect(calls).toBe(1);
});

test("retries on transient error and succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    },
    3,
    0,
  );
  expect(result).toBe("recovered");
  expect(calls).toBe(3);
});

test("throws RetryExhaustedError after maxAttempts transient failures", async () => {
  let calls = 0;
  const err = await withRetry(
    async () => {
      calls++;
      throw new Error("always fails");
    },
    3,
    0,
  ).catch((e) => e);

  expect(err).toBeInstanceOf(RetryExhaustedError);
  expect((err as RetryExhaustedError).attempts).toBe(3);
  expect(calls).toBe(3);
});

test("RetryExhaustedError wraps the original cause", async () => {
  const original = new Error("original");
  const err = await withRetry(
    async () => {
      throw original;
    },
    2,
    0,
  ).catch((e) => e);
  expect(err).toBeInstanceOf(RetryExhaustedError);
  expect((err as RetryExhaustedError).cause).toBe(original);
});

test("does not retry on permanent error — fails on first attempt", async () => {
  let calls = 0;
  const err = await withRetry(
    async () => {
      calls++;
      throw new ProviderAuthError("openai");
    },
    3,
    0,
  ).catch((e) => e);

  expect(err).toBeInstanceOf(ProviderAuthError);
  expect(calls).toBe(1);
});

test("permanent error is re-thrown directly, not wrapped in RetryExhaustedError", async () => {
  const err = await withRetry(
    async () => {
      throw new ModelNotFoundError("openai", "gpt-99");
    },
    3,
    0,
  ).catch((e) => e);

  expect(err).toBeInstanceOf(ModelNotFoundError);
  expect(err).not.toBeInstanceOf(RetryExhaustedError);
});

test("respects maxAttempts=1 — no retries", async () => {
  let calls = 0;
  const err = await withRetry(
    async () => {
      calls++;
      throw new Error("fail");
    },
    1,
    0,
  ).catch((e) => e);

  expect(err).toBeInstanceOf(RetryExhaustedError);
  expect((err as RetryExhaustedError).attempts).toBe(1);
  expect(calls).toBe(1);
});
