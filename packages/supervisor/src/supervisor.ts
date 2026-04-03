import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RestartPolicy } from "./restart";

/** Error thrown when another supervisor is already running for this $LOOM_HOME. */
export class SupervisorAlreadyRunningError extends Error {
  constructor(pid: number, loomHome: string) {
    super(`Supervisor already running (pid ${pid}) for ${loomHome}`);
    this.name = "SupervisorAlreadyRunningError";
  }
}

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
  private sighupHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  constructor(opts: SupervisorOptions) {
    this.loomHome = opts.loomHome;
    this.scanIntervalMs = opts.scanIntervalMs ?? 5_000;
  }

  /** Start the supervisor and begin scanning for agents. */
  start(): void {
    if (this.running) return;

    const existingPid = Supervisor.readPid(this.loomHome);
    if (existingPid !== null) {
      if (Supervisor.isAlive(existingPid)) {
        throw new SupervisorAlreadyRunningError(existingPid, this.loomHome);
      }
      unlinkSync(join(this.loomHome, "supervisor.pid"));
    }

    this.running = true;

    writeFileSync(join(this.loomHome, "supervisor.pid"), `${process.pid}\n`, "utf8");

    this.scan();
    this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);

    this.sighupHandler = () => this.scan();
    this.sigtermHandler = () => this.stop();
    process.on("SIGHUP", this.sighupHandler);
    process.on("SIGTERM", this.sigtermHandler);
  }

  /** Stop the supervisor and all managed agents. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    if (this.sighupHandler) {
      process.removeListener("SIGHUP", this.sighupHandler);
      this.sighupHandler = null;
    }
    if (this.sigtermHandler) {
      process.removeListener("SIGTERM", this.sigtermHandler);
      this.sigtermHandler = null;
    }

    for (const agent of this.agents.values()) {
      agent.process?.kill();
    }
    this.agents.clear();

    const pidPath = join(this.loomHome, "supervisor.pid");
    if (existsSync(pidPath)) {
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

  /** Check whether a process with the given PID is alive. */
  static isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "EPERM") {
        return true;
      }
      return false;
    }
  }
}
