import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RestartPolicy } from "./restart";

export interface SupervisorOptions {
  /** Root directory for loom state ($LOOM_HOME). */
  loomHome: string;
  /** Scan interval in milliseconds (default: 5000). */
  scanIntervalMs?: number;
}

/** Managed agent entry tracked by the supervisor. */
interface ManagedAgent {
  name: string;
  process: ReturnType<typeof Bun.spawn> | null;
  restartCount: number;
  restartPolicy: RestartPolicy;
}

/**
 * Process manager for loom agents.
 *
 * Spawns runners, detects crashes, and restarts with backoff.
 * Writes its PID to $LOOM_HOME/supervisor.pid.
 */
export class Supervisor {
  readonly loomHome: string;
  private scanIntervalMs: number;
  private agents = new Map<string, ManagedAgent>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: SupervisorOptions) {
    this.loomHome = opts.loomHome;
    this.scanIntervalMs = opts.scanIntervalMs ?? 5_000;
  }

  /** Start the supervisor and begin scanning for agents. */
  start(): void {
    if (this.running) return;
    this.running = true;

    const pidPath = join(this.loomHome, "supervisor.pid");
    writeFileSync(pidPath, `${process.pid}\n`, "utf8");

    this.scan();
    this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);

    process.on("SIGHUP", () => this.scan());
  }

  /** Stop the supervisor and all managed agents. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    for (const agent of this.agents.values()) {
      agent.process?.kill();
    }
    this.agents.clear();

    const pidPath = join(this.loomHome, "supervisor.pid");
    if (existsSync(pidPath)) {
      const { unlinkSync } = require("node:fs");
      unlinkSync(pidPath);
    }
  }

  /** Scan agent directories for status changes. */
  private scan(): void {
    // Scan implementation — reads $LOOM_HOME/agents/*/status
    // and spawns/stops runners as needed.
  }

  /** Read the supervisor PID from the filesystem, or null if not running. */
  static readPid(loomHome: string): number | null {
    const pidPath = join(loomHome, "supervisor.pid");
    if (!existsSync(pidPath)) return null;
    const raw = readFileSync(pidPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isNaN(pid) ? null : pid;
  }
}
