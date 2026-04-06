import { afterEach, beforeEach, expect, test } from "bun:test";
import { ModelNotFoundError } from "../errors";
import { OllamaProvider } from "./ollama";

const originalFetch = globalThis.fetch;

function mockFetchCapture(
  status: number,
  body: unknown,
): { getRequest: () => { url: string; init: RequestInit } } {
  let captured: { url: string; init: RequestInit };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured = { url, init: init! };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { getRequest: () => captured };
}

const OK_RESPONSE = { choices: [{ message: { role: "assistant", content: "Hi" } }] };

beforeEach(() => {
  delete process.env.OLLAMA_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("default base URL is http://localhost:11434", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OllamaProvider();
  await provider.chat("qwen2.5:3b", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("http://localhost:11434/v1/chat/completions");
});

test("OLLAMA_BASE_URL env overrides default", async () => {
  process.env.OLLAMA_BASE_URL = "http://remote:11434";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OllamaProvider();
  await provider.chat("qwen2.5:3b", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("http://remote:11434/v1/chat/completions");
});

test("constructor baseUrl overrides env", async () => {
  process.env.OLLAMA_BASE_URL = "http://env:11434";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OllamaProvider({ baseUrl: "http://constructor:11434" });
  await provider.chat("qwen2.5:3b", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("http://constructor:11434/v1/chat/completions");
});

test("no Authorization header is sent", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OllamaProvider();
  await provider.chat("qwen2.5:3b", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers.authorization).toBeUndefined();
});

test("404 includes ollama pull hint", async () => {
  mockFetchCapture(404, { error: { message: "model not found" } });
  const provider = new OllamaProvider();
  await expect(provider.chat("qwen2.5:3b", "", [{ role: "user", content: "Hi" }])).rejects.toThrow(
    "Run: ollama pull qwen2.5:3b",
  );
});

test("404 throws ModelNotFoundError", async () => {
  mockFetchCapture(404, { error: { message: "model not found" } });
  const provider = new OllamaProvider();
  await expect(provider.chat("qwen2.5:3b", "", [{ role: "user", content: "Hi" }])).rejects.toThrow(
    ModelNotFoundError,
  );
});

test("trailing slash on baseUrl is stripped", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OllamaProvider({ baseUrl: "http://localhost:11434/" });
  await provider.chat("qwen2.5:3b", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("http://localhost:11434/v1/chat/completions");
});
