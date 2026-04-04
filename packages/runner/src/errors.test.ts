import { expect, test } from "bun:test";
import { ModelNotFoundError, ProviderAuthError } from "./errors";

test("ProviderAuthError has correct name and message", () => {
  const err = new ProviderAuthError("anthropic");
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("ProviderAuthError");
  expect(err.message).toContain("anthropic");
  expect(err.message).toContain("API key");
});

test("ModelNotFoundError has correct name and message", () => {
  const err = new ModelNotFoundError("anthropic", "claude-unknown");
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("ModelNotFoundError");
  expect(err.message).toContain("claude-unknown");
  expect(err.message).toContain("anthropic");
});

test("ModelNotFoundError includes hint when provided", () => {
  const err = new ModelNotFoundError("ollama", "qwen2.5:3b", "Run: ollama pull qwen2.5:3b");
  expect(err.message).toContain("ollama pull qwen2.5:3b");
});
