import { ProviderAuthError } from "./errors";
import { AnthropicProvider } from "./providers/anthropic";
import { EchoProvider } from "./providers/echo";
import { OllamaProvider } from "./providers/ollama";
import { OpenAiProvider } from "./providers/openai";
import { OpenRouterProvider } from "./providers/openrouter";

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

/** Create a registry pre-loaded with all built-in providers.
 * Providers that require an API key are skipped silently when no key is available. */
export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register("anthropic", new AnthropicProvider());
  registry.register("echo", new EchoProvider());
  registry.register("ollama", new OllamaProvider());
  for (const [name, factory] of [
    ["openai", () => new OpenAiProvider()],
    ["openrouter", () => new OpenRouterProvider()],
  ] as [string, () => Provider][]) {
    try {
      registry.register(name, factory());
    } catch (e) {
      if (!(e instanceof ProviderAuthError)) throw e;
    }
  }
  return registry;
}

const KNOWN_PREFIXES = ["ollama", "anthropic", "openai", "openrouter", "echo"] as const;

/** Result of resolving a prefixed model string. */
export interface ResolvedProvider {
  provider: Provider;
  modelName: string;
}

/**
 * Resolve a (possibly prefixed) model string to a provider and bare model name.
 * No prefix defaults to Ollama. Throws if the prefix is unknown or the provider is not registered.
 */
export function resolveProvider(model: string, registry: ProviderRegistry): ResolvedProvider {
  const slashIdx = model.indexOf("/");
  let providerName: string;
  let modelName: string;

  if (slashIdx === -1) {
    providerName = "ollama";
    modelName = model;
  } else {
    providerName = model.slice(0, slashIdx);
    modelName = model.slice(slashIdx + 1);

    if (!(KNOWN_PREFIXES as readonly string[]).includes(providerName)) {
      throw new Error(
        `Unknown provider prefix "${providerName}". Known prefixes: ${KNOWN_PREFIXES.join(", ")}`,
      );
    }
  }

  const provider = registry.get(providerName);
  if (!provider) {
    throw new Error(`Provider "${providerName}" is not registered`);
  }

  return { provider, modelName };
}
