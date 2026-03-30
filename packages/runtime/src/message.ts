/**
 * @file Message creation, validation, and lifecycle management.
 * @module @loom/runtime/message
 *
 * Provides utilities to send, read, list, and consume messages stored as
 * JSON files in an agent's inbox directory. Each message is written as a
 * `.msg` file named `{timestamp}-{id}.msg`. Consumed messages are moved
 * to a `.processed/` subdirectory for auditability.
 */

import { exists, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const MESSAGE_VERSION = 1;

export interface Message {
  /** Schema version — allows safe migration when the format changes. */
  v: typeof MESSAGE_VERSION;
  id: string;
  from: string;
  ts: number;
  body: string;
}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function send(root: string, agent: string, from: string, body: string): Promise<Message> {
  const id = generateId();
  const ts = Date.now();

  const message: Message = { v: MESSAGE_VERSION, id, from, ts, body };

  const path = join(root, agent, "inbox", `${ts}-${id}.msg`);
  return Bun.file(path)
    .write(JSON.stringify(message, null, 2))
    .then(() => message);
}

export function isMessage(obj: unknown): obj is Message {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "v" in obj &&
    typeof obj.v === "number" &&
    "id" in obj &&
    typeof obj.id === "string" &&
    "from" in obj &&
    typeof obj.from === "string" &&
    "ts" in obj &&
    typeof obj.ts === "number" &&
    "body" in obj &&
    typeof obj.body === "string"
  );
}

/** List pending (unprocessed) message files in a directory, sorted chronologically. */
export async function list(dir: string): Promise<string[]> {
  const dirExists = await exists(dir);
  if (!dirExists) {
    return [];
  }

  const files = await readdir(dir);

  return files.filter((f) => f.endsWith(".msg")).sort();
}

export async function read(dir: string, filename: string): Promise<Message> {
  const file = Bun.file(join(dir, filename));

  const fileExists = await file.exists();

  if (!fileExists) {
    throw new Error(`Message file ${filename} does not exist in ${dir}`);
  }

  const raw = await Bun.file(join(dir, filename)).text();

  const parsed = JSON.parse(raw);

  if (!isMessage(parsed)) {
    throw new Error(`Invalid message format in file ${filename}`);
  }

  if (parsed.v > MESSAGE_VERSION) {
    throw new Error(
      `Message ${filename} has version ${parsed.v}, runtime only supports up to ${MESSAGE_VERSION}. ` +
        "Update loom to read this message.",
    );
  }

  return parsed as Message;
}

/** Move an unreadable message to .unreadable/ for inspection. */
export async function quarantine(dir: string, filename: string): Promise<void> {
  const unreadableDir = join(dir, ".unreadable");
  await mkdir(unreadableDir, { recursive: true });
  await rename(join(dir, filename), join(unreadableDir, filename));
}

/** Read, parse, and move a message to .processed/, returning its parsed content. */
export async function consume(dir: string, filename: string) {
  const msg = await read(dir, filename);
  const processedDir = join(dir, ".processed");
  await mkdir(processedDir, { recursive: true });
  await rename(join(dir, filename), join(processedDir, filename));
  return msg;
}
