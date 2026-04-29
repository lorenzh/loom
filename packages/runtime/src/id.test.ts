import { expect, test } from "bun:test";
import { generateId } from "./id";

test("generateId returns a 16-character lowercase hex string", () => {
  const id = generateId();

  expect(id).toHaveLength(16);
  expect(id).toMatch(/^[0-9a-f]{16}$/);
});
