import { afterEach, beforeEach, expect, test } from "bun:test";
import { ModelNotFoundError, ProviderAuthError } from "../errors";
import { OpenAiCompatibleProvider } from "./openai-compatible";

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
  choices: [
    {
      message: {
        role: "assistant",
        content: "Hello",
      },
    },
  ],
};

function createProvider(overrides?: Partial<import("./openai-compatible").OpenAiCompatibleConfig>) {
  return new OpenAiCompatibleProvider({
    providerName: "test",
    baseUrl: "https://api.example.com",
    headers: {},
    ...overrides,
  });
}

beforeEach(() => {});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("successful text response", async () => {
  mockFetch(200, OK_RESPONSE);
  const provider = createProvider();
  const result = await provider.chat("test-model", "Be helpful", [{ role: "user", content: "Hi" }]);
  expect(result.text).toBe("Hello");
  expect(result.toolCalls).toBeUndefined();
});

test("null content returns empty string", async () => {
  mockFetch(200, { choices: [{ message: { role: "assistant", content: null } }] });
  const provider = createProvider();
  const result = await provider.chat("test-model", "", [{ role: "user", content: "Hi" }]);
  expect(result.text).toBe("");
});

test("tool call response maps to toolCalls", async () => {
  mockFetch(200, {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"query":"test"}' },
            },
          ],
        },
      },
    ],
  });
  const provider = createProvider();
  const result = await provider.chat("test-model", "", [
    { role: "user", content: "Search for test" },
  ]);
  expect(result.text).toBe("");
  expect(result.toolCalls).toEqual([{ id: "call_1", name: "search", input: { query: "test" } }]);
});

test("mixed text and tool_calls", async () => {
  mockFetch(200, {
    choices: [
      {
        message: {
          role: "assistant",
          content: "Let me search for that.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"loom"}' },
            },
          ],
        },
      },
    ],
  });
  const provider = createProvider();
  const result = await provider.chat("test-model", "", [{ role: "user", content: "Find loom" }]);
  expect(result.text).toBe("Let me search for that.");
  expect(result.toolCalls).toEqual([{ id: "call_1", name: "search", input: { q: "loom" } }]);
});

test("401 throws ProviderAuthError", async () => {
  mockFetch(401, { error: { message: "Invalid key" } });
  const provider = createProvider();
  await expect(provider.chat("test-model", "", [{ role: "user", content: "Hi" }])).rejects.toThrow(
    ProviderAuthError,
  );
});

test("404 throws ModelNotFoundError", async () => {
  mockFetch(404, { error: { message: "Model not found" } });
  const provider = createProvider();
  await expect(
    provider.chat("nonexistent-model", "", [{ role: "user", content: "Hi" }]),
  ).rejects.toThrow(ModelNotFoundError);
});

test("404 includes hint when modelNotFoundHint is configured", async () => {
  mockFetch(404, { error: { message: "Model not found" } });
  const provider = createProvider({
    modelNotFoundHint: (model) => `Run: ollama pull ${model}`,
  });
  await expect(provider.chat("qwen2.5:3b", "", [{ role: "user", content: "Hi" }])).rejects.toThrow(
    "Run: ollama pull qwen2.5:3b",
  );
});

test("500 throws generic Error with status", async () => {
  mockFetch(500, { error: { message: "Internal error" } });
  const provider = createProvider();
  await expect(provider.chat("test-model", "", [{ role: "user", content: "Hi" }])).rejects.toThrow(
    /test API error \(500\)/,
  );
});

test("system prompt is included as first message when non-empty", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = createProvider();
  await provider.chat("test-model", "Be concise", [{ role: "user", content: "Hi" }]);
  const messages = cap.getRequest().body.messages as Array<Record<string, unknown>>;
  expect(messages[0]).toEqual({ role: "system", content: "Be concise" });
  expect(messages[1]).toEqual({ role: "user", content: "Hi" });
});

test("system prompt is omitted when empty", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = createProvider();
  await provider.chat("test-model", "", [{ role: "user", content: "Hi" }]);
  const messages = cap.getRequest().body.messages as Array<Record<string, unknown>>;
  expect(messages[0]).toEqual({ role: "user", content: "Hi" });
});

test("tool message is mapped to OpenAI tool format", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = createProvider();
  await provider.chat("test-model", "", [
    { role: "user", content: "Search for test" },
    { role: "assistant", content: "" },
    { role: "tool", content: '{"result": "found"}', toolCallId: "call_1" },
  ]);
  const messages = cap.getRequest().body.messages as Array<Record<string, unknown>>;
  expect(messages[2]).toEqual({
    role: "tool",
    tool_call_id: "call_1",
    content: '{"result": "found"}',
  });
});

test("custom headers are passed through", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = createProvider({
    headers: { authorization: "Bearer sk-test", "x-custom": "value" },
  });
  await provider.chat("test-model", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer sk-test");
  expect(headers["x-custom"]).toBe("value");
});

test("trailing slash on baseUrl is stripped", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = createProvider({ baseUrl: "https://api.example.com/" });
  await provider.chat("test-model", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://api.example.com/v1/chat/completions");
});

test("model is sent in request body", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = createProvider();
  await provider.chat("gpt-4o", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().body.model).toBe("gpt-4o");
});

test("fetch URL uses baseUrl with /v1/chat/completions", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = createProvider({ baseUrl: "https://custom.example.com" });
  await provider.chat("test-model", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://custom.example.com/v1/chat/completions");
});
