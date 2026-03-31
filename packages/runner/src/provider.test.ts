import { expect, test } from "bun:test";
import { type Provider, ProviderRegistry } from "./provider";

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
