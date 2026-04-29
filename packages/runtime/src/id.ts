/** @file Identifier helpers shared by runtime file writers. */

/** Generate a 16-character lowercase hexadecimal identifier. */
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}
