/**
 * @file Message creation, validation, and lifecycle management.
 * @module @loom/runtime/message
 *
 * Provides utilities to send, read, list, and consume messages stored as
 * JSON files in an agent's inbox directory. Each message is written as a
 * `.msg` file named `{timestamp}-{id}.msg`. Consumed messages are moved
 * to a `.processed/` subdirectory for auditability.
 */

import { exists, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MESSAGE_VERSION = 1;

export interface Message {
  /** Schema version — allows safe migration when the format changes. */
  v: typeof MESSAGE_VERSION;
  id: string;
  from: string;
  ts: number;
  body: string;
  /** Inbox filename that triggered this reply — used for idempotent restart recovery. */
  in_reply_to?: string;
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

/** Write an outbox message referencing the inbox filename that triggered it. */
export function sendReply(
  root: string,
  agent: string,
  from: string,
  body: string,
  inReplyTo: string,
): Promise<Message> {
  const id = generateId();
  const ts = Date.now();

  const message: Message = { v: MESSAGE_VERSION, id, from, ts, body, in_reply_to: inReplyTo };

  const path = join(root, agent, "outbox", `${ts}-${id}.msg`);
  return Bun.file(path)
    .write(JSON.stringify(message, null, 2))
    .then(() => message);
}

/** Returns true when `obj` conforms to the `Message` shape. */
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
    typeof obj.body === "string" &&
    (!("in_reply_to" in obj) || typeof (obj as { in_reply_to: unknown }).in_reply_to === "string")
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

/** Move a message from inbox to .in-progress/ and return its parsed content. */
export async function claim(dir: string, filename: string): Promise<Message> {
  const msg = await read(dir, filename);
  const inProgressDir = join(dir, ".in-progress");
  await mkdir(inProgressDir, { recursive: true });
  await rename(join(dir, filename), join(inProgressDir, filename));
  return msg;
}

/** Move a message from .in-progress/ to .processed/. */
export async function acknowledge(dir: string, filename: string): Promise<void> {
  const processedDir = join(dir, ".processed");
  await mkdir(processedDir, { recursive: true });
  await rename(join(dir, ".in-progress", filename), join(processedDir, filename));
}

/** Read, parse, and move a message to .processed/, returning its parsed content. */
export async function consume(dir: string, filename: string): Promise<Message> {
  const msg = await claim(dir, filename);
  await acknowledge(dir, filename);
  return msg;
}

export interface FailError {
  ts: string;
  attempts: number;
  last_error: string;
  error_type: string;
}

/** Move a message from .in-progress/ to .failed/ and write a companion .error.json file. */
export async function fail(dir: string, filename: string, error: FailError): Promise<void> {
  const failedDir = join(dir, ".failed");
  await mkdir(failedDir, { recursive: true });
  await rename(join(dir, ".in-progress", filename), join(failedDir, filename));
  await writeFile(
    join(failedDir, `${filename}.error.json`),
    JSON.stringify(error, null, 2),
    "utf8",
  );
}
