import { join } from "node:path";
import { type AgentEntry, ProcessTable } from "@losoft/loom-runtime";

/** List all agents with name, status, model, and pid. */
export async function ps(args: string[], loomHome: string): Promise<void> {
  const table = new ProcessTable(join(loomHome, "agents"));
  const entries = table.entries();

  if (args.includes("--json")) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log("No agents found.");
    return;
  }

  printTable(entries);
}

function printTable(entries: AgentEntry[]): void {
  const header = { name: "NAME", status: "STATUS", model: "MODEL", pid: "PID" };

  const widths = {
    name: Math.max(header.name.length, ...entries.map((e) => e.name.length)),
    status: Math.max(header.status.length, ...entries.map((e) => e.status.length)),
    model: Math.max(header.model.length, ...entries.map((e) => e.model.length)),
    pid: Math.max(header.pid.length, ...entries.map((e) => String(e.pid ?? "—").length)),
  };

  const row = (name: string, status: string, model: string, pid: string) =>
    `${name.padEnd(widths.name)}  ${status.padEnd(widths.status)}  ${model.padEnd(widths.model)}  ${pid}`;

  console.log(row(header.name, header.status, header.model, header.pid));
  for (const e of entries) {
    console.log(row(e.name, e.status, e.model, String(e.pid ?? "—")));
  }
}
