import { OpenAiCompatibleProvider } from "./openai-compatible";

export interface OpenAiProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

/** OpenAI provider using the /v1/chat/completions endpoint. */
export class OpenAiProvider extends OpenAiCompatibleProvider {
  constructor(options?: OpenAiProviderOptions) {
    const apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    super({
      providerName: "openai",
      baseUrl: options?.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
      headers: { authorization: `Bearer ${apiKey}` },
    });
  }
}
