import { afterEach, beforeEach, expect, test } from "bun:test";
import { ProviderAuthError } from "../errors";
import { OpenAiProvider } from "./openai";

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
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("default base URL is https://api.openai.com", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenAiProvider({ apiKey: "sk-test" });
  await provider.chat("gpt-4o", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://api.openai.com/v1/chat/completions");
});

test("OPENAI_BASE_URL env overrides default", async () => {
  process.env.OPENAI_BASE_URL = "https://custom.openai.com";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenAiProvider({ apiKey: "sk-test" });
  await provider.chat("gpt-4o", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://custom.openai.com/v1/chat/completions");
});

test("constructor baseUrl overrides env", async () => {
  process.env.OPENAI_BASE_URL = "https://env.openai.com";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenAiProvider({
    apiKey: "sk-test",
    baseUrl: "https://constructor.openai.com",
  });
  await provider.chat("gpt-4o", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://constructor.openai.com/v1/chat/completions");
});

test("apiKey falls back to OPENAI_API_KEY env var", async () => {
  process.env.OPENAI_API_KEY = "env-key";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenAiProvider();
  await provider.chat("gpt-4o", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer env-key");
});

test("constructor apiKey overrides env", async () => {
  process.env.OPENAI_API_KEY = "env-key";
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenAiProvider({ apiKey: "constructor-key" });
  await provider.chat("gpt-4o", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer constructor-key");
});

test("Authorization Bearer header is sent", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenAiProvider({ apiKey: "sk-test" });
  await provider.chat("gpt-4o", "", [{ role: "user", content: "Hi" }]);
  const headers = cap.getRequest().init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer sk-test");
});

test("trailing slash on baseUrl is stripped", async () => {
  const cap = mockFetchCapture(200, OK_RESPONSE);
  const provider = new OpenAiProvider({ apiKey: "sk-test", baseUrl: "https://api.openai.com/" });
  await provider.chat("gpt-4o", "", [{ role: "user", content: "Hi" }]);
  expect(cap.getRequest().url).toBe("https://api.openai.com/v1/chat/completions");
});

test("throws ProviderAuthError at construction when no key is provided", () => {
  expect(() => new OpenAiProvider()).toThrow(ProviderAuthError);
});

test("throws ProviderAuthError at construction when OPENAI_API_KEY env is not set", () => {
  expect(() => new OpenAiProvider({})).toThrow(ProviderAuthError);
});
