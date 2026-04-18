import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentProcess,
  acknowledge,
  claim,
  type FailError,
  fail,
  InboxWatcher,
  recover,
  sendReply,
} from "@losoft/loom-runtime";
import { type ProviderRegistry, resolveProvider } from "./provider";
import { RetryExhaustedError, withRetry } from "./retry";

/** Append a user+assistant turn to the agent's daily conversation file. */
async function appendConversationTurn(
  conversationsDir: string,
  userContent: string,
  userTs: string,
  assistantContent: string,
  assistantTs: string,
): Promise<void> {
  const date = new Intl.DateTimeFormat("en-CA").format(new Date());
  const filePath = join(conversationsDir, `${date}.ndjson`);
  const lines =
    `${JSON.stringify({ role: "user", content: userContent, ts: userTs })}\n` +
    `${JSON.stringify({ role: "assistant", content: assistantContent, ts: assistantTs })}\n`;
  await appendFile(filePath, lines, "utf8");
}

export interface AgentRunnerOptions {
  /** Polling interval in milliseconds (default 200). */
  pollIntervalMs?: number;
  /** System prompt sent to the LLM on every turn. */
  systemPrompt?: string;
  /** Called after each outbox reply is written. */
  onReply?: (text: string) => void;
  /** When set, only process this specific message file and skip crash recovery. */
  targetFilename?: string;
  /** Base delay in ms for retry backoff (default 1000). Override in tests. */
  retryBaseDelayMs?: number;
}

/**
 * Manages a single agent's message loop: polls inbox, calls LLM, writes outbox replies.
 *
 * Messages are processed strictly sequentially (FIFO). A drain queue ensures that
 * even if multiple messages arrive in one poll cycle, only one LLM call is in flight
 * at a time.
 *
 * Uses the three-phase message lifecycle (inbox → .in-progress → .processed) so that
 * in-flight messages are recoverable after a crash.
 */
export class AgentRunner {
  private readonly agent: AgentProcess;
  private readonly watcher: InboxWatcher;
  private readonly inboxDir: string;
  private readonly systemPrompt: string;
  private readonly onReply?: (text: string) => void;
  private readonly targetFilename?: string;
  private readonly retryBaseDelayMs: number;
  private readonly queue: string[] = [];
  private draining = false;
  private drainPromise: Promise<void> = Promise.resolve();
  private resolveRun: (() => void) | null = null;
  private stopped = false;

  constructor(
    /** Agents root directory — $LOOM_HOME/agents. */
    private readonly home: string,
    private readonly agentName: string,
    private readonly registry: ProviderRegistry,
    options?: AgentRunnerOptions,
  ) {
    this.agent = new AgentProcess(home, agentName);
    this.inboxDir = join(home, agentName, "inbox");
    this.systemPrompt = options?.systemPrompt ?? "";
    this.onReply = options?.onReply;
    this.targetFilename = options?.targetFilename;
    this.retryBaseDelayMs = options?.retryBaseDelayMs ?? 1000;
    this.watcher = InboxWatcher.forAgent(home, agentName, {
      pollIntervalMs: options?.pollIntervalMs,
    });

    this.watcher.on("message", (filename) => {
      if (this.targetFilename && filename !== this.targetFilename) return;
      this.queue.push(filename);
      this.drainPromise = this.drain();
    });
  }

  /** Process queued messages one at a time (FIFO). */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const filename = this.queue.shift();
        if (filename !== undefined) await this.processMessage(filename);
      }
    } catch {
      // processMessage has its own error handler. If fail() itself throws
      // (e.g. ENOENT from a cleanup race), the error reply was already sent —
      // swallow to prevent unhandled rejections leaking across tests.
    } finally {
      this.draining = false;
    }
  }

  /** Process a single message: claim → LLM → reply → acknowledge. On failure: error reply → fail(). */
  private async processMessage(filename: string): Promise<void> {
    const message = await claim(this.inboxDir, filename);
    this.agent.status = "running";

    const origin = message.origin ? `${message.origin}/${filename}` : filename;

    try {
      const userTs = new Date().toISOString();
      const { provider, modelName } = resolveProvider(this.agent.model, this.registry);
      const response = await withRetry(
        () =>
          provider.chat(modelName, this.systemPrompt, [{ role: "user", content: message.body }]),
        3,
        this.retryBaseDelayMs,
      );
      const assistantTs = new Date().toISOString();

      await sendReply(this.home, this.agentName, response.text, origin);
      await acknowledge(this.inboxDir, filename);
      try {
        await appendConversationTurn(
          join(this.home, this.agentName, "conversations"),
          message.body,
          userTs,
          response.text,
          assistantTs,
        );
      } catch {
        // History write failure must not affect message processing
      }
      this.agent.status = "idle";
      this.onReply?.(response.text);
    } catch (err) {
      const isExhausted = err instanceof RetryExhaustedError;
      const cause = isExhausted ? err.cause : err;
      const attempts = isExhausted ? err.attempts : 1;
      const errorMessage = cause instanceof Error ? cause.message : String(cause);
      const errorType = cause instanceof Error ? cause.constructor.name : "UnknownError";

      await sendReply(this.home, this.agentName, errorMessage, origin, true);

      const failError: FailError = {
        ts: new Date().toISOString(),
        attempts,
        last_error: errorMessage,
        error_type: errorType,
      };
      await fail(this.inboxDir, filename, failError);
      this.agent.status = "idle";
    }
  }

  /** Start the agent loop. Returns a Promise that resolves when stop() is called. */
  async run(): Promise<void> {
    if (!this.targetFilename) {
      await recover(this.inboxDir, join(this.home, this.agentName, "outbox"));
    }
    if (this.stopped) return;
    this.watcher.start();
    return new Promise<void>((resolve) => {
      this.resolveRun = resolve;
    });
  }

  /** Stop the polling loop. Resolves run() only after any in-flight drain completes. */
  stop(): void {
    this.stopped = true;
    this.watcher.stop();
    void this.drainPromise.finally(() => {
      this.resolveRun?.();
      this.resolveRun = null;
    });
  }
}
