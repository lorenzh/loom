/** @file Atomic file write utilities using .tmp → rename pattern. */

import { renameSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";

/** Write content to a file atomically using a .tmp intermediate. */
export function atomicWriteSync(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Write content to a file atomically using a .tmp intermediate (async). */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, content);
  await rename(tmp, path);
}
