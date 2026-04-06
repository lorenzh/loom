import { OpenAiCompatibleProvider } from "./openai-compatible";

export interface OllamaProviderOptions {
  baseUrl?: string;
}

/** Ollama provider using the OpenAI-compatible /v1/chat/completions endpoint. */
export class OllamaProvider extends OpenAiCompatibleProvider {
  constructor(options?: OllamaProviderOptions) {
    super({
      providerName: "ollama",
      baseUrl: options?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      headers: {},
      modelNotFoundHint: (model) => `Run: ollama pull ${model}`,
    });
  }
}
