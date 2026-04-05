import { expect, test } from "bun:test";
import { EchoProvider } from "./echo";

test("echoes the last user message", async () => {
  const provider = new EchoProvider();
  const res = await provider.chat("any-model", "system prompt", [
    { role: "user", content: "hello world" },
  ]);
  expect(res.text).toBe("hello world");
});

test("echoes the last user message when multiple messages exist", async () => {
  const provider = new EchoProvider();
  const res = await provider.chat("any-model", "", [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ]);
  expect(res.text).toBe("second");
});

test("returns empty string when no user messages exist", async () => {
  const provider = new EchoProvider();
  const res = await provider.chat("any-model", "", []);
  expect(res.text).toBe("");
});
