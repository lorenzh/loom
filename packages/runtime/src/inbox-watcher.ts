/**
 * @file Inbox directory watcher that emits parsed messages when new `.msg` files appear.
 * @module @loom/runtime/inbox-watcher
 *
 * Polls a given inbox directory at a configurable interval (default 200 ms).
 * When `.msg` files are found, they are read, parsed, moved to `.processed/`,
 * and emitted as `message` events. The timer is unref'd so it does not prevent
 * the process from exiting.
 */

import { EventEmitter } from "node:events";
import { join } from "node:path";
import { consume, list, type Message, quarantine } from "./message";

export interface InboxWatcherOptions {
  /** Polling interval in milliseconds (default 200). */
  pollIntervalMs?: number;
}

interface InboxWatcherEventMap {
  message: [filename: string, message: Message];
  error: [error: Error];
}

/**
 * Polls an inbox directory for new `.msg` files, reads and parses them,
 * moves them to `.processed/`, and emits a `message` event with the
 * filename and parsed {@link Message}.
 *
 * @fires message When a new `.msg` file is consumed from the inbox directory.
 * @fires error When a file cannot be read or parsed.
 */
export class InboxWatcher extends EventEmitter<InboxWatcherEventMap> {
  private timer: Timer | null = null;
  private polling = false;
  readonly inbox: string;
  readonly pollIntervalMs: number;

  constructor(inbox: string, options?: InboxWatcherOptions) {
    super();
    this.inbox = inbox;
    this.pollIntervalMs = options?.pollIntervalMs ?? 200;
  }

  /** Runs a single poll cycle: list, consume, and emit for each `.msg` file. */
  private async poll(): Promise<void> {
    if (this.polling || !this.timer) return;
    this.polling = true;
    try {
      const files = await list(this.inbox);
      for (const filename of files) {
        if (!this.timer) break;
        try {
          const message = await consume(this.inbox, filename);
          this.emit("message", filename, message);
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
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref();
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
