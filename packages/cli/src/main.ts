#!/usr/bin/env bun

import { down } from "./commands/down";
import { logs } from "./commands/logs";
import { ps } from "./commands/ps";
import { run } from "./commands/run";
import { send } from "./commands/send";
import { stop } from "./commands/stop";
import { up } from "./commands/up";

/** Resolve $LOOM_HOME, defaulting to ~/.loom. */
function resolveLoomHome(): string {
  return process.env.LOOM_HOME ?? `${process.env.HOME}/.loom`;
}

const commands: Record<string, (args: string[], loomHome: string) => Promise<void>> = {
  run,
  ps,
  stop,
  up,
  down,
  send,
  logs,
};

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(0);
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const loomHome = resolveLoomHome();
  await handler(args, loomHome);
}

function printUsage(): void {
  console.log(`Usage: loom <command> [options]

Commands:
  run    Start a single agent
  up     Start a weave of agents from loom.yml
  ps     List running agents
  stop   Stop a specific agent
  down   Stop all agents from a weave
  send   Send a message to an agent's inbox
  logs   View agent logs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
