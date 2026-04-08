import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRunner, createDefaultRegistry } from "@losoft/loom-runner";
import { AgentProcess, send as sendMsg } from "@losoft/loom-runtime";

const VALUE_FLAGS = new Set(["--model", "--prompt", "--system", "--system-file"]);

/** Parse a named flag value from args (e.g. --model qwen3:8b). */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/** Extract the first positional (non-flag) argument, skipping flag–value pairs. */
function extractName(args: string[]): string | undefined {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (VALUE_FLAGS.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("--")) {
      i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

/** Resolve the system prompt from --system or --system-file flags. */
function resolveSystemPrompt(args: string[]): string {
  const system = flagValue(args, "--system");
  const systemFile = flagValue(args, "--system-file");

  if (system !== undefined && systemFile !== undefined) {
    throw new Error("Cannot use both --system and --system-file");
  }

  if (systemFile !== undefined) {
    return readFileSync(systemFile, "utf8");
  }

  return system ?? "";
}

/** Start a single agent in the foreground or as a one-shot Unix filter. */
export async function run(args: string[], loomHome: string): Promise<void> {
  const name = extractName(args);
  const model = flagValue(args, "--model");
  const useStdin = args.includes("--stdin");
  const promptText = flagValue(args, "--prompt");

  if (!name) {
    throw new Error(
      "Usage: loom agent start <name> --model <model> [--prompt <text>] [--stdin] [--system <text>] [--system-file <path>]",
    );
  }
  if (!model) {
    throw new Error("--model is required");
  }

  const systemPrompt = resolveSystemPrompt(args);
  const registry = createDefaultRegistry();
  const agentsRoot = join(loomHome, "agents");

  // Create agent directory and write config files
  const agent = new AgentProcess(agentsRoot, name);
  agent.model = model;
  agent.pid = process.pid;
  agent.startedAt = new Date().toISOString();
  agent.status = "running";
  if (systemPrompt) {
    writeFileSync(join(agent.dir, "prompt.md"), systemPrompt, "utf8");
  }

  /** Write shutdown state to the agent directory. */
  const shutdown = () => {
    agent.stoppedAt = new Date().toISOString();
    agent.status = "stopped";
    agent.pid = null;
  };

  if (useStdin) {
    // One-shot Unix filter: read stdin → process through runner → write stdout → exit
    let body = "";
    for await (const chunk of process.stdin) {
      body += (chunk as Buffer).toString("utf8");
    }
    body = body.trim();

    if (!body) {
      shutdown();
      throw new Error("No input received on stdin");
    }

    const msg = await sendMsg(agentsRoot, name, "cli", body);
    const targetFilename = `${msg.ts}-${msg.id}.msg`;

    const runner = new AgentRunner(agentsRoot, name, registry, {
      systemPrompt,
      pollIntervalMs: 50,
      targetFilename,
      onReply: (text) => {
        process.stdout.write(text); // No trailing newline — composable as a Unix filter
        runner.stop();
      },
    });

    try {
      await runner.run();
    } finally {
      shutdown();
    }
  } else {
    // Foreground mode: long-running agent with inbox polling
    if (promptText) {
      await sendMsg(agentsRoot, name, "cli", promptText);
    }

    const runner = new AgentRunner(agentsRoot, name, registry, {
      systemPrompt,
      onReply: (text) => {
        console.log(text); // Trailing newline — human-readable terminal output
      },
    });

    const sigintHandler = () => runner.stop();
    process.on("SIGINT", sigintHandler);

    try {
      await runner.run();
    } finally {
      process.removeListener("SIGINT", sigintHandler);
      shutdown();
    }
  }
}
