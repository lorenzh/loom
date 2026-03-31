/** A single message in a conversation turn. */
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Tool call ID — required when role is "tool". */
  toolCallId?: string;
}

/** A tool invocation requested by the LLM. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Response returned by a Provider after a chat turn. */
export interface ChatResponse {
  text: string;
  toolCalls?: ToolCall[];
}

/** Pluggable LLM backend. */
export interface Provider {
  /** Send a chat turn and return the model's response. */
  chat(model: string, system: string, messages: ChatMessage[]): Promise<ChatResponse>;
}

/** Registry mapping provider names to Provider implementations. */
export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  /** Register a provider under the given name. */
  register(name: string, provider: Provider): void {
    this.providers.set(name, provider);
  }

  /** Retrieve a provider by name, or undefined if not registered. */
  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }
}
