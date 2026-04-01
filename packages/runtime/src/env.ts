/** @file Environment helpers — resolves loom runtime paths from env vars with sensible defaults. */
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolves the base directory for loom state. Uses $LOOM_HOME if set, otherwise ~/.loom. */
export function loomHome(): string {
  return process.env.LOOM_HOME ?? join(homedir(), ".loom");
}
