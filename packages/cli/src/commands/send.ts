import { join } from "node:path";
import { send as sendMsg } from "@losoft/loom-runtime";

/** Send a message to an agent's inbox. */
export async function send(args: string[], loomHome: string): Promise<void> {
  const useStdin = args.includes("--stdin");
  const positionalArgs = args.filter((a) => a !== "--stdin");
  const agent = positionalArgs[0];

  if (!agent) {
    throw new Error("Usage: loom send <agent> <message> [--stdin]");
  }

  let body = "";

  if (useStdin) {
    for await (const chunk of process.stdin) {
      body += (chunk as Buffer).toString("utf8");
    }
    body = body.trim();
  } else {
    body = (positionalArgs[1] as string | undefined) ?? "";
    if (body === "") {
      throw new Error("Usage: loom send <agent> <message> [--stdin]");
    }
  }

  const root = join(loomHome, "agents");
  await sendMsg(root, agent, "cli", body);
  console.log(`Message sent to ${agent}`);
}
