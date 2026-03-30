/**
 * @file Multi-agent inbox router that manages InboxWatcher instances per agent.
 * @module @loom/runtime/inbox-router
 *
 * Wraps multiple {@link InboxWatcher} instances behind a single EventEmitter,
 * prefixing each event with the agent name. Callers `add()` agents to start
 * watching and `remove()` them to stop. `stop()` tears down everything.
 */

import { EventEmitter } from "node:events";
import { InboxWatcher, type InboxWatcherOptions } from "./inbox-watcher";
import type { Message } from "./message";

export interface InboxRouterOptions {
    /** Polling interval in milliseconds, passed to each InboxWatcher (default 200). */
    pollIntervalMs?: number;
}

interface InboxRouterEventMap {
    message: [agent: string, filename: string, message: Message];
    error: [agent: string, error: Error];
}

/**
 * Manages one {@link InboxWatcher} per agent, forwarding their events
 * with the agent name prepended.
 *
 * @fires message When any watched agent receives a new `.msg` file.
 * @fires error When any watched agent encounters a read/parse error.
 */
export class InboxRouter extends EventEmitter<InboxRouterEventMap> {
    private readonly watchers = new Map<string, InboxWatcher>();

    constructor(
        readonly home: string,
        readonly options?: InboxRouterOptions,
    ) {
        super();
    }

    /** Add an agent and start watching its inbox. No-op if already added. */
    add(agent: string): void {
        if (this.watchers.has(agent)) return;

        const watcherOpts: InboxWatcherOptions | undefined = this.options?.pollIntervalMs
            ? { pollIntervalMs: this.options.pollIntervalMs }
            : undefined;

        const watcher = InboxWatcher.forAgent(this.home, agent, watcherOpts);

        watcher.on('message', (filename, message) => {
            this.emit('message', agent, filename, message);
        });

        watcher.on('error', (error) => {
            this.emit('error', agent, error);
        });

        this.watchers.set(agent, watcher);
        watcher.start();
    }

    /** Stop and remove an agent's watcher. No-op if not present. */
    remove(agent: string): void {
        const watcher = this.watchers.get(agent);
        if (!watcher) return;

        watcher.stop();
        watcher.removeAllListeners();
        this.watchers.delete(agent);
    }

    /** Whether an agent is currently being watched. */
    has(agent: string): boolean {
        return this.watchers.has(agent);
    }

    /** List all watched agent names. */
    agents(): string[] {
        return [...this.watchers.keys()];
    }

    /** Stop all watchers and clear the map. */
    stop(): void {
        for (const [, watcher] of this.watchers) {
            watcher.stop();
            watcher.removeAllListeners();
        }
        this.watchers.clear();
    }
}
