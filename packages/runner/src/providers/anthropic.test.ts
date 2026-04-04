import { afterEach, beforeEach, expect, test } from "bun:test";
import { ModelNotFoundError, ProviderAuthError } from "../errors";
import { AnthropicProvider } from "./anthropic";

const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Mock fetch that captures the request for assertions. */
function mockFetchCapture(
  status: number,
  body: unknown,
): { getRequest: () => { url: string; init: RequestInit; body: Record<string, unknown> } } {
  let captured: { url: string; init: RequestInit; body: Record<string, unknown> };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured = { url, init: init!, body: JSON.parse(init?.body as string) };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    getRequest: () => captured,
  };
}

const OK_RESPONSE = {
  content: [{ type: "text", text: "Hello" }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("successful text response", async () => {
  mockFetch(200, OK_RESPONSE);
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  const result = await provider.chat("claude-sonnet-4-6", "Be helpful", [
    { role: "user", content: "Hi" },
  ]);
  expect(result.text).toBe("Hello");
  expect(result.toolCalls).toBeUndefined();
});

test("multiple text blocks are concatenated", async () => {
  mockFetch(200, {
    content: [
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  const result = await provider.chat("claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  expect(result.text).toBe("Hello world");
});

test("tool use response maps to toolCalls", async () => {
  mockFetch(200, {
    content: [{ type: "tool_use", id: "toolu_1", name: "search", input: { query: "test" } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  });
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  const result = await provider.chat("claude-sonnet-4-6", "", [
    { role: "user", content: "Search for test" },
  ]);
  expect(result.text).toBe("");
  expect(result.toolCalls).toEqual([{ id: "toolu_1", name: "search", input: { query: "test" } }]);
});

test("mixed text and tool_use blocks", async () => {
  mockFetch(200, {
    content: [
      { type: "text", text: "Let me search for that." },
      { type: "tool_use", id: "toolu_1", name: "search", input: { q: "loom" } },
    ],
    usage: { input_tokens: 10, output_tokens: 25 },
  });
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  const result = await provider.chat("claude-sonnet-4-6", "", [
    { role: "user", content: "Find loom" },
  ]);
  expect(result.text).toBe("Let me search for that.");
  expect(result.toolCalls).toEqual([{ id: "toolu_1", name: "search", input: { q: "loom" } }]);
});

test("401 throws ProviderAuthError", async () => {
  mockFetch(401, {
    type: "error",
    error: { type: "authentication_error", message: "Invalid key" },
  });
  const provider = new AnthropicProvider({ apiKey: "bad-key" });
  await expect(
    provider.chat("claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]),
  ).rejects.toThrow(ProviderAuthError);
});

test("404 throws ModelNotFoundError", async () => {
  mockFetch(404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  await expect(
    provider.chat("claude-nonexistent", "", [{ role: "user", content: "Hi" }]),
  ).rejects.toThrow(ModelNotFoundError);
});

test("500 throws generic Error with status", async () => {
  mockFetch(500, { type: "error", error: { type: "api_error", message: "Internal error" } });
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  await expect(
    provider.chat("claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]),
  ).rejects.toThrow(/Anthropic API error \(500\)/);
});

test("system prompt is included when non-empty", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  await provider.chat("claude-sonnet-4-6", "Be concise", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().body.system).toBe("Be concise");
});

test("system prompt is omitted when empty", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  await provider.chat("claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().body.system).toBeUndefined();
});

test("custom baseUrl is used in fetch URL", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    baseUrl: "https://custom.example.com",
  });
  await provider.chat("claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://custom.example.com/v1/messages");
});

test("constructor apiKey overrides env", async () => {
  process.env.ANTHROPIC_API_KEY = "env-key";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new AnthropicProvider({ apiKey: "constructor-key" });
  await provider.chat("claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("constructor-key");
});

test("tool message is mapped to Anthropic tool_result format", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new AnthropicProvider({ apiKey: "sk-test" });
  await provider.chat("claude-sonnet-4-6", "", [
    { role: "user", content: "Search for test" },
    {
      role: "assistant",
      content: "",
    },
    { role: "tool", content: '{"result": "found"}', toolCallId: "toolu_1" },
  ]);
  const messages = cap.getRequest().body.messages as Array<Record<string, unknown>>;
  const toolMsg = messages[2]!;
  expect(toolMsg.role).toBe("user");
  expect(toolMsg.content).toEqual([
    { type: "tool_result", tool_use_id: "toolu_1", content: '{"result": "found"}' },
  ]);
});

test("apiKey falls back to ANTHROPIC_API_KEY env var", async () => {
  process.env.ANTHROPIC_API_KEY = "env-key";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new AnthropicProvider();
  await provider.chat("claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers["x-api-key"]).toBe("env-key");
});

test("trailing slash on baseUrl is stripped", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    baseUrl: "https://custom.example.com/",
  });
  await provider.chat("claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://custom.example.com/v1/messages");
});
