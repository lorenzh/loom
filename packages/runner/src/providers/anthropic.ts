import { ModelNotFoundError, ProviderAuthError } from "../errors";
import type { ChatMessage, ChatResponse, Provider, ToolCall } from "../provider";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MAX_TOKENS = 4096;
const API_VERSION = "2023-06-01";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicErrorResponse {
  type: "error";
  error: { type: string; message: string };
}

/** Convert loom ChatMessages to Anthropic message format. */
function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: msg.toolCallId ?? "",
            content: msg.content,
          },
        ],
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

/** Extract text from Anthropic content blocks. */
function extractText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Extract tool calls from Anthropic content blocks. */
function extractToolCalls(blocks: AnthropicContentBlock[]): ToolCall[] | undefined {
  const calls = blocks
    .filter(
      (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
        b.type === "tool_use",
    )
    .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
  return calls.length > 0 ? calls : undefined;
}

/** Anthropic provider using the /v1/messages REST API with plain fetch(). */
export class AnthropicProvider implements Provider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;

  /** Creates a new AnthropicProvider with the given options, falling back to env vars. */
  constructor(options?: AnthropicProviderOptions) {
    this.apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.baseUrl = (options?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /** Send a chat turn to the Anthropic Messages API. */
  async chat(model: string, system: string, messages: ChatMessage[]): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: this.maxTokens,
      messages: toAnthropicMessages(messages),
    };
    if (system) {
      body.system = system;
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let errorMessage = `Anthropic API error (${response.status})`;
      try {
        const err = (await response.json()) as AnthropicErrorResponse;
        errorMessage = err.error?.message ?? errorMessage;
      } catch {
        /* use default message */
      }

      if (response.status === 401) {
        throw new ProviderAuthError("anthropic");
      }
      if (response.status === 404) {
        throw new ModelNotFoundError("anthropic", model);
      }
      throw new Error(`Anthropic API error (${response.status}): ${errorMessage}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    return {
      text: extractText(data.content),
      toolCalls: extractToolCalls(data.content),
    };
  }
}
