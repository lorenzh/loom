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
import { atomicWrite } from "./atomic-write";

const MESSAGE_VERSION = 1;

export interface Message {
  /** Schema version — allows safe migration when the format changes. */
  v: typeof MESSAGE_VERSION;
  id: string;
  from: string;
  ts: number;
  body: string;
  /** Slash-delimited path of message filenames tracing this pipeline run. */
  origin?: string;
  /** True when this message signals a processing failure. */
  error?: boolean;
}

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Write a message to an agent's inbox. */
export async function send(
  root: string,
  agent: string,
  from: string,
  body: string,
): Promise<Message> {
  const id = generateId();
  const ts = Date.now();

  const message: Message = { v: MESSAGE_VERSION, id, from, ts, body };

  const inboxDir = join(root, agent, "inbox");
  await mkdir(inboxDir, { recursive: true });
  const path = join(inboxDir, `${ts}-${id}.msg`);
  await atomicWrite(path, JSON.stringify(message, null, 2));
  return message;
}

/** Write an outbox message referencing the pipeline origin path. */
export async function sendReply(
  root: string,
  agent: string,
  body: string,
  origin: string,
  error?: boolean,
): Promise<Message> {
  const id = generateId();
  const ts = Date.now();

  const message: Message = {
    v: MESSAGE_VERSION,
    id,
    from: agent,
    ts,
    body,
    origin,
    ...(error ? { error } : {}),
  };

  const outboxDir = join(root, agent, "outbox");
  await mkdir(outboxDir, { recursive: true });
  const path = join(outboxDir, `${ts}-${id}.msg`);
  await atomicWrite(path, JSON.stringify(message, null, 2));
  return message;
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
    (!("origin" in obj) || typeof (obj as { origin: unknown }).origin === "string") &&
    (!("error" in obj) || typeof (obj as { error: unknown }).error === "boolean")
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

/**
 * Recover in-progress messages left by a previous crash.
 *
 * For each file in `inboxDir/.in-progress/`:
 * - If `outboxDir` has a reply whose origin's last segment matches → acknowledge (move to `.processed/`).
 * - Otherwise → move back to `inboxDir` for reprocessing.
 */
export async function recover(inboxDir: string, outboxDir: string): Promise<void> {
  const inProgressDir = join(inboxDir, ".in-progress");

  const inProgressFiles = await list(inProgressDir);
  if (inProgressFiles.length === 0) return;

  const outboxFiles = await list(outboxDir);
  const repliedTo = new Set<string>();
  for (const f of outboxFiles) {
    const msg = await read(outboxDir, f);
    if (msg.origin) {
      const parent = msg.origin.split("/").pop();
      if (parent) repliedTo.add(parent);
    }
  }

  for (const filename of inProgressFiles) {
    if (repliedTo.has(filename)) {
      await acknowledge(inboxDir, filename);
    } else {
      await rename(join(inProgressDir, filename), join(inboxDir, filename));
    }
  }
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
  await atomicWrite(join(failedDir, `${filename}.error.json`), JSON.stringify(error, null, 2));
}
