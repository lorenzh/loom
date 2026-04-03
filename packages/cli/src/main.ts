#!/usr/bin/env bun

import { loomHome } from "@losoft/loom-runtime";
import { down } from "./commands/down";
import { logs } from "./commands/logs";
import { ps } from "./commands/ps";
import { run } from "./commands/run";
import { send } from "./commands/send";
import { stop } from "./commands/stop";
import { up } from "./commands/up";

type CommandHandler = (args: string[], loomHome: string) => Promise<void>;

const agentCommands: Record<string, CommandHandler> = {
  start: run,
  ps,
  stop,
  send,
  logs,
};

const topLevelCommands: Record<string, CommandHandler> = {
  up,
  down,
};

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);

  if (!first || first === "--help" || first === "-h") {
    printUsage();
    process.exit(0);
  }

  const home = loomHome();

  // loom agent <subcommand> [args...]
  if (first === "agent") {
    const [subcommand, ...args] = rest;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printAgentUsage();
      process.exit(0);
    }

    const handler = agentCommands[subcommand];
    if (!handler) {
      console.error(`Unknown agent command: ${subcommand}`);
      printAgentUsage();
      process.exit(1);
    }

    await handler(args, home);
    return;
  }

  // Top-level commands (up, down)
  const handler = topLevelCommands[first];
  if (!handler) {
    console.error(`Unknown command: ${first}`);
    printUsage();
    process.exit(1);
  }

  await handler(rest, home);
}

function printUsage(): void {
  console.log(`Usage: loom <command> [options]

Commands:
  agent <subcommand>   Manage individual agents
  up                   Start agents from loom.yml
  down                 Stop all agents from loom.yml

Run 'loom agent --help' for agent subcommands.`);
}

function printAgentUsage(): void {
  console.log(`Usage: loom agent <command> [options]

Commands:
  start <name>   Start an agent
  ps             List agents
  stop <name>    Stop an agent
  send <name>    Send a message to an agent
  logs <name>    View agent logs`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
