import { afterEach, beforeEach, expect, test } from "bun:test";
import { ProviderAuthError } from "../errors";
import { OpenRouterProvider } from "./openrouter";

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
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("base URL is https://openrouter.ai/api", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenRouterProvider({ apiKey: "sk-or-test" });
  await provider.chat("anthropic/claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://openrouter.ai/api/v1/chat/completions");
});

test("apiKey falls back to OPENROUTER_API_KEY env var", async () => {
  process.env.OPENROUTER_API_KEY = "env-key";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenRouterProvider();
  await provider.chat("anthropic/claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer env-key");
});

test("constructor apiKey overrides env", async () => {
  process.env.OPENROUTER_API_KEY = "env-key";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenRouterProvider({ apiKey: "constructor-key" });
  await provider.chat("anthropic/claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer constructor-key");
});

test("Authorization Bearer header is sent", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenRouterProvider({ apiKey: "sk-or-test" });
  await provider.chat("anthropic/claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer sk-or-test");
});

test("HTTP-Referer header is sent", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenRouterProvider({ apiKey: "sk-or-test" });
  await provider.chat("anthropic/claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers["http-referer"]).toBe("https://github.com/losoft-org/loom");
});

test("X-Title header is sent", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenRouterProvider({ apiKey: "sk-or-test" });
  await provider.chat("anthropic/claude-sonnet-4-6", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers["x-title"]).toBe("loom");
});

test("throws ProviderAuthError at construction when no key is provided", () => {
  expect(() => new OpenRouterProvider()).toThrow(ProviderAuthError);
});

test("throws ProviderAuthError at construction when OPENROUTER_API_KEY env is not set", () => {
  expect(() => new OpenRouterProvider({})).toThrow(ProviderAuthError);
});
