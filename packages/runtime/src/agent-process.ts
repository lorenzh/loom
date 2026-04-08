/** @file Filesystem-backed agent process state — reads and writes per-agent files under $LOOM_HOME/agents/{name}/. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Read a file relative to the agent directory, returning null if missing. */
function readField(agentDir: string, field: string): string | null {
  const p = join(agentDir, field);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim() || null;
}

function writeField(agentDir: string, field: string, value: string): void {
  writeFileSync(join(agentDir, field), `${value}\n`, "utf8");
}

export type AgentStatus =
  | "pending"
  | "running"
  | "idle"
  | "dead"
  | "error"
  | "restarting"
  | "stopped";

export interface AgentEntry {
  name: string;
  pid: number | null;
  status: AgentStatus;
  model: string;
  startedAt: string | null;
  stoppedAt: string | null;
  dir: string;
}

/**
 * Filesystem-backed state for a single agent.
 *
 * Each field is stored as a plain text file inside the agent's directory.
 * The caller provides the parent directory (e.g. `$LOOM_HOME/agents`);
 * the agent subdirectory is created automatically.
 */
export class AgentProcess {
  private readonly _name: string;
  private readonly _agentDir: string;

  constructor(home: string, name: string) {
    this._name = name;
    this._agentDir = join(home, name);
    mkdirSync(this._agentDir, { recursive: true });
    for (const subdir of ["inbox", "outbox", "memory", "logs", "crashes", "conversations"]) {
      mkdirSync(join(this._agentDir, subdir), { recursive: true });
    }
  }

  get name(): string {
    return this._name;
  }

  get pid(): number | null {
    const raw = readField(this._agentDir, "pid");
    return raw ? Number(raw) : null;
  }

  set pid(value: number | null) {
    writeField(this._agentDir, "pid", value == null ? "" : String(value));
  }

  get status(): AgentStatus {
    return (readField(this._agentDir, "status") as AgentStatus) || "idle";
  }

  set status(value: AgentStatus) {
    writeField(this._agentDir, "status", value);
  }

  get model(): string {
    return readField(this._agentDir, "model") || "unknown";
  }

  set model(value: string) {
    writeField(this._agentDir, "model", value);
  }

  get startedAt(): string | null {
    return readField(this._agentDir, "started_at");
  }

  set startedAt(value: string | null) {
    writeField(this._agentDir, "started_at", value || "");
  }

  get stoppedAt(): string | null {
    return readField(this._agentDir, "stopped_at");
  }

  set stoppedAt(value: string | null) {
    writeField(this._agentDir, "stopped_at", value || "");
  }

  get dir(): string {
    return this._agentDir;
  }

  get entry(): AgentEntry {
    return {
      name: this._name,
      pid: this.pid,
      status: this.status,
      model: this.model,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      dir: this.dir,
    };
  }
}
