import { expect, test } from "bun:test";
import {
  createDefaultRegistry,
  type Provider,
  ProviderRegistry,
  resolveProvider,
} from "./provider";

test("register and get a provider", () => {
  const registry = new ProviderRegistry();
  const provider: Provider = {
    chat: async () => ({ text: "hi" }),
  };
  registry.register("test", provider);
  expect(registry.get("test")).toBe(provider);
});

test("get returns undefined for unknown provider", () => {
  const registry = new ProviderRegistry();
  expect(registry.get("missing")).toBeUndefined();
});

test("register overwrites existing provider", () => {
  const registry = new ProviderRegistry();
  const a: Provider = { chat: async () => ({ text: "a" }) };
  const b: Provider = { chat: async () => ({ text: "b" }) };
  registry.register("p", a);
  registry.register("p", b);
  expect(registry.get("p")).toBe(b);
});

// resolveProvider tests

function makeRegistryWithStub(name: string): { registry: ProviderRegistry; stub: Provider } {
  const registry = new ProviderRegistry();
  const stub: Provider = { chat: async () => ({ text: "" }) };
  registry.register(name, stub);
  return { registry, stub };
}

test("resolveProvider: no prefix defaults to ollama", () => {
  const { registry, stub } = makeRegistryWithStub("ollama");
  const result = resolveProvider("llama3", registry);
  expect(result.modelName).toBe("llama3");
  expect(result.provider).toBe(stub);
});

test("resolveProvider: ollama/ prefix", () => {
  const { registry, stub } = makeRegistryWithStub("ollama");
  const result = resolveProvider("ollama/llama3", registry);
  expect(result.modelName).toBe("llama3");
  expect(result.provider).toBe(stub);
});

test("resolveProvider: anthropic/ prefix", () => {
  const { registry, stub } = makeRegistryWithStub("anthropic");
  const result = resolveProvider("anthropic/claude-3-5-sonnet", registry);
  expect(result.modelName).toBe("claude-3-5-sonnet");
  expect(result.provider).toBe(stub);
});

test("resolveProvider: openai/ prefix", () => {
  const { registry, stub } = makeRegistryWithStub("openai");
  const result = resolveProvider("openai/gpt-4o", registry);
  expect(result.modelName).toBe("gpt-4o");
  expect(result.provider).toBe(stub);
});

test("resolveProvider: openrouter/ prefix", () => {
  const { registry, stub } = makeRegistryWithStub("openrouter");
  const result = resolveProvider("openrouter/meta-llama/llama-3", registry);
  expect(result.modelName).toBe("meta-llama/llama-3");
  expect(result.provider).toBe(stub);
});

test("resolveProvider: unknown prefix throws", () => {
  const { registry } = makeRegistryWithStub("ollama");
  expect(() => resolveProvider("cohere/command-r", registry)).toThrow(
    'Unknown provider prefix "cohere"',
  );
});

test("resolveProvider: unregistered provider throws", () => {
  const registry = new ProviderRegistry(); // empty — no ollama registered
  expect(() => resolveProvider("llama3", registry)).toThrow('Provider "ollama" is not registered');
});

// createDefaultRegistry tests

test("createDefaultRegistry registers anthropic and echo providers", () => {
  const registry = createDefaultRegistry();
  expect(registry.get("anthropic")).toBeDefined();
  expect(registry.get("echo")).toBeDefined();
});

test("createDefaultRegistry: echo provider works end-to-end", async () => {
  const registry = createDefaultRegistry();
  const { provider, modelName } = resolveProvider("echo/test", registry);
  const response = await provider.chat(modelName, "", [{ role: "user", content: "ping" }]);
  expect(response.text).toBe("ping");
});
