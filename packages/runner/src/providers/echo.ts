import type { ChatMessage, ChatResponse, Provider } from "../provider";

/** Provider that echoes the last user message — useful for testing without an API key. */
export class EchoProvider implements Provider {
  async chat(_model: string, _system: string, messages: ChatMessage[]): Promise<ChatResponse> {
    const last = messages.findLast((m) => m.role === "user");
    return { text: last?.content ?? "" };
  }
}
