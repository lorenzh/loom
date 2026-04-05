/**
 * @file Inbox directory watcher that notifies when new `.msg` files appear.
 * @module @loom/runtime/inbox-watcher
 *
 * Polls a given inbox directory at a configurable interval (default 200 ms).
 * When new `.msg` files are found they are validated and emitted as `message`
 * events. Files are NOT moved — lifecycle management (claim / acknowledge /
 * fail) is the responsibility of the consumer. Invalid files are quarantined
 * and emitted as `error` events.
 */

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { list, quarantine, read } from "./message";

export interface InboxWatcherOptions {
  /** Polling interval in milliseconds (default 200). */
  pollIntervalMs?: number;
}

interface InboxWatcherEventMap {
  message: [filename: string];
  error: [error: Error];
}

/**
 * Polls an inbox directory for new `.msg` files, validates them, and emits a
 * `message` event with the filename. Files are not moved — the consumer is
 * responsible for calling `claim()` / `acknowledge()` / `fail()`.
 *
 * @fires message When a new valid `.msg` file is detected in the inbox.
 * @fires error When a file cannot be read or parsed; the file is quarantined.
 */
export class InboxWatcher extends EventEmitter<InboxWatcherEventMap> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly seen = new Set<string>();
  readonly inbox: string;
  readonly pollIntervalMs: number;

  constructor(inbox: string, options?: InboxWatcherOptions) {
    super();
    this.inbox = inbox;
    this.pollIntervalMs = options?.pollIntervalMs ?? 200;
  }

  /** Runs a single poll cycle: detect new files, validate, emit. */
  private async poll(): Promise<void> {
    if (this.polling || !this.timer) return;
    this.polling = true;
    try {
      const files = await list(this.inbox);

      // Remove files that have left the inbox (claimed, moved, etc.)
      for (const filename of this.seen) {
        if (!files.includes(filename)) {
          this.seen.delete(filename);
        }
      }

      for (const filename of files) {
        if (this.seen.has(filename)) continue;
        try {
          await read(this.inbox, filename);
          this.seen.add(filename);
          this.emit("message", filename);
        } catch (err) {
          await quarantine(this.inbox, filename);
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.polling = false;
    }
  }

  /** Starts polling the inbox directory for new files. */
  start(): void {
    // Timer is intentionally ref'd (not unref'd): keeps the process alive while the runner
    // is active, including in one-shot --stdin mode where no other handles exist.
    // Callers must call stop() to allow the process to exit.
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /** Stops polling the inbox directory. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether the watcher is currently active. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** Creates an InboxWatcher scoped to a single agent's inbox directory. */
  static forAgent(home: string, name: string, options?: InboxWatcherOptions): InboxWatcher {
    return new InboxWatcher(join(home, name, "inbox"), options);
  }
}
