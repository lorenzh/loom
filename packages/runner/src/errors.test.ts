import { expect, test } from "bun:test";
import { ModelNotFoundError, ProviderAuthError, ToolCallParseError } from "./errors";

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

test("ToolCallParseError has correct name and message", () => {
  const err = new ToolCallParseError("search", "{bad json", new SyntaxError("Unexpected token"));
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("ToolCallParseError");
  expect(err.message).toContain("search");
  expect(err.message).toContain("{bad json");
  expect(err.cause).toBeInstanceOf(SyntaxError);
});
