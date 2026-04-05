import { join } from "node:path";
import {
  AgentProcess,
  acknowledge,
  claim,
  InboxWatcher,
  recover,
  sendReply,
} from "@losoft/loom-runtime";
import { type ProviderRegistry, resolveProvider } from "./provider";

export interface AgentRunnerOptions {
  /** Polling interval in milliseconds (default 200). */
  pollIntervalMs?: number;
  /** System prompt sent to the LLM on every turn. */
  systemPrompt?: string;
  /** Called after each outbox reply is written. */
  onReply?: (text: string) => void;
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
  private readonly queue: string[] = [];
  private draining = false;
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
    this.watcher = InboxWatcher.forAgent(home, agentName, {
      pollIntervalMs: options?.pollIntervalMs,
    });

    this.watcher.on("message", (filename) => {
      this.queue.push(filename);
      this.drain();
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
    } finally {
      this.draining = false;
    }
  }

  /** Process a single message: claim → LLM → reply → acknowledge. */
  private async processMessage(filename: string): Promise<void> {
    const message = await claim(this.inboxDir, filename);
    this.agent.status = "running";

    const { provider, modelName } = resolveProvider(this.agent.model, this.registry);
    const response = await provider.chat(modelName, this.systemPrompt, [
      { role: "user", content: message.body },
    ]);

    const origin = message.origin ? `${message.origin}/${filename}` : filename;
    await sendReply(this.home, this.agentName, response.text, origin);
    await acknowledge(this.inboxDir, filename);
    this.agent.status = "idle";
    this.onReply?.(response.text);
  }

  /** Start the agent loop. Returns a Promise that resolves when stop() is called. */
  async run(): Promise<void> {
    this.agent.status = "idle";
    await recover(this.inboxDir, join(this.home, this.agentName, "outbox"));
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
}
