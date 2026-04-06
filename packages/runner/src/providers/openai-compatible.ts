import { ModelNotFoundError, ProviderAuthError } from "../errors";
import type { ChatMessage, ChatResponse, Provider, ToolCall } from "../provider";

/** Configuration for an OpenAI-compatible provider. */
export interface OpenAiCompatibleConfig {
  providerName: string;
  baseUrl: string;
  headers: Record<string, string>;
  modelNotFoundHint?: (model: string) => string;
}

interface OpenAiChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAiToolCall[];
  };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiErrorResponse {
  error?: { message?: string };
}

/** Convert loom ChatMessages to OpenAI message format. */
function toOpenAiMessages(system: string, messages: ChatMessage[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  if (system) {
    result.push({ role: "system", content: system });
  }
  for (const msg of messages) {
    if (msg.role === "tool") {
      result.push({ role: "tool", tool_call_id: msg.toolCallId ?? "", content: msg.content });
    } else {
      result.push({ role: msg.role, content: msg.content });
    }
  }
  return result;
}

/** Extract tool calls from an OpenAI choice. */
function extractToolCalls(choice: OpenAiChoice): ToolCall[] | undefined {
  const calls = choice.message.tool_calls;
  if (!calls || calls.length === 0) return undefined;
  return calls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
  }));
}

/** Provider for any OpenAI-compatible chat completions API. */
export class OpenAiCompatibleProvider implements Provider {
  private readonly config: OpenAiCompatibleConfig;

  /** Creates a provider with the given configuration. */
  constructor(config: OpenAiCompatibleConfig) {
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/$/, "") };
  }

  /** Send a chat turn to an OpenAI-compatible /v1/chat/completions endpoint. */
  async chat(model: string, system: string, messages: ChatMessage[]): Promise<ChatResponse> {
    const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.config.headers },
      body: JSON.stringify({ model, messages: toOpenAiMessages(system, messages) }),
    });

    if (!response.ok) {
      let errorMessage = `${this.config.providerName} API error (${response.status})`;
      try {
        const err = (await response.json()) as OpenAiErrorResponse;
        errorMessage = err.error?.message ?? errorMessage;
      } catch {
        /* use default message */
      }

      if (response.status === 401) {
        throw new ProviderAuthError(this.config.providerName);
      }
      if (response.status === 404) {
        throw new ModelNotFoundError(
          this.config.providerName,
          model,
          this.config.modelNotFoundHint?.(model),
        );
      }
      throw new Error(
        `${this.config.providerName} API error (${response.status}): ${errorMessage}`,
      );
    }

    const data = (await response.json()) as { choices: OpenAiChoice[] };
    const choice = data.choices[0];
    if (!choice) {
      throw new Error(`${this.config.providerName}: response contained no choices`);
    }
    return {
      text: choice.message.content ?? "",
      toolCalls: extractToolCalls(choice),
    };
  }
}
