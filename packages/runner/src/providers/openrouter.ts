import { ProviderAuthError } from "../errors";
import { OpenAiCompatibleProvider } from "./openai-compatible";

export interface OpenRouterProviderOptions {
  apiKey?: string;
}

/** OpenRouter provider using the OpenAI-compatible /v1/chat/completions endpoint. */
export class OpenRouterProvider extends OpenAiCompatibleProvider {
  constructor(options?: OpenRouterProviderOptions) {
    const apiKey = options?.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new ProviderAuthError("openrouter");
    }
    super({
      providerName: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "http-referer": "https://github.com/losoft-org/loom",
        "x-title": "loom",
      },
    });
  }
}
