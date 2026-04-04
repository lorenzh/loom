import { join } from "node:path";
import { send as sendMsg } from "@losoft/loom-runtime";

/** Send a message to an agent's inbox. */
export async function send(args: string[], loomHome: string): Promise<void> {
  const stdinIdx = args.indexOf("--stdin");
  const useStdin = stdinIdx !== -1;

  const positionalArgs = args.filter((a) => a !== "--stdin");
  const agent = positionalArgs[0];

  if (!agent) {
    console.error("Usage: loom send <agent> <message> [--stdin]");
    process.exit(1);
  }

  let body = "";

  if (useStdin) {
    for await (const chunk of process.stdin) {
      body += chunk;
    }
  } else {
    body = (positionalArgs[1] as string | undefined) ?? "";
    if (body === "") {
      console.error("Usage: loom send <agent> <message> [--stdin]");
      process.exit(1);
    }
  }

  const root = join(loomHome, "agents");
  await sendMsg(root, agent, "cli", body);
  console.log(`Message sent to ${agent}`);
}
