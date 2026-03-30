/**
 * @file Process table — manages multiple agent entries on the filesystem.
 * @module @loom/runtime/process-table
 *
 * Wraps {@link AgentProcess} instances, one per agent subdirectory under
 * a shared home directory. Provides enumeration, lookup, and removal.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AgentProcess, type AgentEntry } from './agent-process';

export class ProcessTable {
    constructor(readonly home: string) {}

    /** Get or create an AgentProcess for the given name. */
    get(name: string): AgentProcess {
        return new AgentProcess(this.home, name);
    }

    /** Check if an agent directory exists. */
    has(name: string): boolean {
        return existsSync(join(this.home, name));
    }

    /** List all agent names (subdirectories of home). */
    agents(): string[] {
        if (!existsSync(this.home)) return [];
        return readdirSync(this.home).filter((entry) => {
            return statSync(join(this.home, entry)).isDirectory();
        });
    }

    /** Return entries for all agents. */
    entries(): AgentEntry[] {
        return this.agents().map((name) => this.get(name).entry);
    }

    /** Remove an agent's directory entirely. */
    remove(name: string): void {
        const dir = join(this.home, name);
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
}
