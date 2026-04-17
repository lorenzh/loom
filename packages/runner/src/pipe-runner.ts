/**
 * @file PipeRunner — drives a pipe instance: polls inbox, executes operator chain, writes steps + outbox.
 * @module @loom/runner/pipe-runner
 *
 * Each message is claimed from inbox/, run through the operator chain step by step,
 * with intermediate results written to steps/N/. The final step output is written
 * to outbox/. Drop (non-zero exit) short-circuits the chain without writing to outbox.
 * Unrecoverable errors write a failure reply to outbox and move the original to .failed/.
 *
 * @see ADR-010
 */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  acknowledge,
  atomicWrite,
  claim,
  type FailError,
  fail,
  InboxWatcher,
  type InboxWatcherOptions,
  type Message,
} from "@losoft/loom-runtime";

// ── Operator types ─────────────────────────────────────────────────────────

export interface CommandOperatorConfig {
  operator: "command";
  /** Shell command to run. stdin = message body. stdout lines = output messages. */
  cmd: string;
  /** Timeout in ms before the command is killed and the message is forwarded unchanged (default: 30_000). */
  timeoutMs?: number;
}

/** Union of all operator config types (extended as new operators are added). */
export type OperatorConfig = CommandOperatorConfig;

export interface PipeConfig {
  operators: OperatorConfig[];
}

// ── PipeRunner ─────────────────────────────────────────────────────────────

export interface PipeRunnerOptions {
  /** Polling interval for the inbox watcher in ms (default: 200). */
  pollIntervalMs?: number;
}

/**
 * Drives a single pipe instance.
 *
 * Polls the instance's `inbox/`, runs each message through the configured
 * operator chain, writes intermediate results to `steps/N/`, and writes
 * final results to `outbox/`.
 */
export class PipeRunner {
  private readonly instanceName: string;
  private readonly inboxDir: string;
  private readonly outboxDir: string;
  private readonly stepsDir: string;
  private readonly statusFile: string;
  private readonly watcher: InboxWatcher;
  private readonly queue: string[] = [];
  private draining = false;
  private stopped = false;
  private resolveRun: (() => void) | null = null;

  constructor(
    readonly instanceDir: string,
    private readonly config: PipeConfig,
    options?: PipeRunnerOptions,
  ) {
    this.instanceName = basename(instanceDir);
    this.inboxDir = join(instanceDir, "inbox");
    this.outboxDir = join(instanceDir, "outbox");
    this.stepsDir = join(instanceDir, "steps");
    this.statusFile = join(instanceDir, "status");

    const watcherOpts: InboxWatcherOptions = { pollIntervalMs: options?.pollIntervalMs };
    this.watcher = new InboxWatcher(this.inboxDir, watcherOpts);
    this.watcher.on("message", (filename) => {
      this.queue.push(filename);
      this.drain().catch(() => {});
    });
  }

  /** Start the pipe loop. Returns a Promise that resolves when stop() is called. */
  async run(): Promise<void> {
    if (this.stopped) return;
    this.watcher.start();
    return new Promise<void>((resolve) => {
      this.resolveRun = resolve;
    });
  }

  /** Stop the polling loop. */
  stop(): void {
    this.stopped = true;
    this.watcher.stop();
    this.resolveRun?.();
    this.resolveRun = null;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const filename = this.queue.shift();
        if (filename !== undefined) await this.processMessage(filename);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Process a single message through the full operator chain. */
  private async processMessage(filename: string): Promise<void> {
    const message = await claim(this.inboxDir, filename);
    await this.setStatus("running");

    const origin = message.origin ? `${message.origin}/${filename}` : filename;

    try {
      let currentBodies: string[] = [message.body];

      for (let i = 0; i < this.config.operators.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: i is within bounds, checked by loop condition
        const op = this.config.operators[i]!;
        const nextBodies: string[] = [];

        for (const body of currentBodies) {
          const result = await this.runOperator(op, body);
          if (result === null) {
            // Drop — short-circuit the entire chain
            await acknowledge(this.inboxDir, filename);
            await this.setStatus("idle");
            return;
          }
          nextBodies.push(...result);
        }

        // Write step outputs
        const stepDir = join(this.stepsDir, String(i));
        await mkdir(stepDir, { recursive: true });
        for (const body of nextBodies) {
          await this.writeMessage(stepDir, body, origin);
        }

        currentBodies = nextBodies;

        if (currentBodies.length === 0) {
          // All outputs dropped
          await acknowledge(this.inboxDir, filename);
          await this.setStatus("idle");
          return;
        }
      }

      // Write final results to outbox
      await mkdir(this.outboxDir, { recursive: true });
      for (const body of currentBodies) {
        await this.writeMessage(this.outboxDir, body, origin);
      }

      await acknowledge(this.inboxDir, filename);
      await this.setStatus("idle");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorType = err instanceof Error ? err.constructor.name : "UnknownError";

      // Write failure reply to outbox
      await mkdir(this.outboxDir, { recursive: true });
      await this.writeMessage(this.outboxDir, errorMessage, origin, true);

      const failError: FailError = {
        ts: new Date().toISOString(),
        attempts: 1,
        last_error: errorMessage,
        error_type: errorType,
      };
      await fail(this.inboxDir, filename, failError);
      await this.setStatus("idle");
    }
  }

  /** Dispatch to the correct operator implementation. */
  private async runOperator(op: OperatorConfig, body: string): Promise<string[] | null> {
    if (op.operator === "command") {
      return this.runCommandOperator(op, body);
    }
    // Unknown operator type — forward unchanged (fail-safe)
    return [body];
  }

  /**
   * Run a command operator.
   *
   * - stdin: message body
   * - stdout: each non-empty line becomes a separate output message body
   * - exit 0 with output: forward
   * - exit non-zero: drop (return null)
   * - crash / timeout: forward unchanged (fail-safe)
   */
  private async runCommandOperator(
    op: CommandOperatorConfig,
    body: string,
  ): Promise<string[] | null> {
    const timeoutMs = op.timeoutMs ?? 30_000;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["sh", "-c", op.cmd], {
        stdin: new Blob([body]),
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch {
      // Spawn failure — forward unchanged (fail-safe)
      return [body];
    }

    const timeoutId = { ref: null as ReturnType<typeof setTimeout> | null };

    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId.ref = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const exitPromise = (async () => {
      const [stdout, , code] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      return { stdout, code };
    })();

    const result = await Promise.race([exitPromise, timeoutPromise]);

    if (timeoutId.ref !== null) clearTimeout(timeoutId.ref);

    if (result === "timeout") {
      proc.kill();
      // Timeout — forward unchanged (fail-safe)
      return [body];
    }

    const { stdout, code } = result;

    if (code !== 0) {
      // Non-zero exit — drop
      return null;
    }

    const lines = stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean);
    if (lines.length === 0) {
      // No output — drop
      return null;
    }

    return lines;
  }

  /** Write a message file to a directory. */
  private async writeMessage(
    dir: string,
    body: string,
    origin: string,
    error?: boolean,
  ): Promise<void> {
    const ts = Date.now();
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const msg: Message = {
      v: 1,
      id,
      from: this.instanceName,
      ts,
      body,
      origin,
      ...(error ? { error: true } : {}),
    };
    const filename = `${ts}-${id}.msg`;
    await atomicWrite(join(dir, filename), JSON.stringify(msg, null, 2));
  }

  private async setStatus(status: "running" | "idle"): Promise<void> {
    await atomicWrite(this.statusFile, status);
  }
}
