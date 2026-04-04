/** Error thrown when a provider rejects the API key (HTTP 401). */
export class ProviderAuthError extends Error {
  constructor(provider: string) {
    super(`Authentication failed for provider "${provider}". Check your API key.`);
    this.name = "ProviderAuthError";
  }
}

/** Error thrown when a requested model does not exist on the provider (HTTP 404). */
export class ModelNotFoundError extends Error {
  constructor(provider: string, model: string, hint?: string) {
    const msg = hint
      ? `Model "${model}" not found on ${provider}. ${hint}`
      : `Model "${model}" not found on ${provider}.`;
    super(msg);
    this.name = "ModelNotFoundError";
  }
}
