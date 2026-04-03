# ADR-013: Model routing and provider abstraction

**Status:** Accepted
**Date:** 2026-04-03

## Context

loom agents need to call LLMs. There are several ways to do this:

- **Local via Ollama** — zero cost, no network, requires local GPU, 5-70B models
- **Local via LM Studio** — OpenAI-compatible API on localhost
- **Remote via Anthropic** — best capability, costs money, requires connectivity
- **Remote via OpenRouter** — access to hundreds of models, unified billing
- **Remote via any OpenAI-compatible endpoint** — includes Together, Fireworks, etc.

The operator might run different agents on different providers:
- Triage agents on cheap/local models (no cost, fast)
- Research agents on powerful remote models (higher cost, better reasoning)
- Notification agents on tiny local models (low latency, no GPU contention)

The routing logic should be transparent — operators should be able to see which model
each agent uses — and it should be trivially overridable at deployment time.

## Decision

### Model string format

Models are identified by a string in one of these forms:

```
# Local Ollama (default if no prefix)
qwen2.5:3b
qwen3.5:9b
llama3.2:latest

# Anthropic
anthropic/claude-sonnet-4-6
anthropic/claude-haiku-4-5

# OpenAI (or compatible)
openai/gpt-4o
openai/gpt-4o-mini

# OpenRouter (any model they carry)
openrouter/qwen/qwen-2.5-72b-instruct
openrouter/anthropic/claude-3.5-sonnet
openrouter/google/gemini-flash-1.5

# Explicit Ollama prefix
ollama/qwen3.5:9b
```

If no prefix is given, the router tries Ollama first. If Ollama is not running,
it falls back to the `LOOM_DEFAULT_PROVIDER` environment variable (default: error).

### Provider resolution

The router resolves a model string to a provider + model name:

```typescript
function resolveProvider(model: string): { provider: Provider; modelName: string } {
  if (model.startsWith('anthropic/')) {
    return { provider: anthropicProvider, modelName: model.slice(10) }
  }
  if (model.startsWith('openai/')) {
    return { provider: openaiProvider, modelName: model.slice(7) }
  }
  if (model.startsWith('openrouter/')) {
    return { provider: openrouterProvider, modelName: model.slice(11) }
  }
  if (model.startsWith('ollama/')) {
    return { provider: ollamaProvider, modelName: model.slice(7) }
  }
  // Default: Ollama
  return { provider: ollamaProvider, modelName: model }
}
```

### Provider implementation — zero external dependencies

All providers are implemented as plain HTTP calls using `fetch()`. No SDKs, no
external runtime dependencies. This is a hard constraint for `@losoft/loom-runtime`.

Ollama exposes two APIs — a native `/api/chat` and an OpenAI-compatible `/v1/chat/completions`.
loom uses the *native* `/api/chat` endpoint to avoid coupling the implementation to OpenAI's
request/response format. The OpenAI-compatible mode remains available as an escape hatch via
`OPENAI_BASE_URL=http://localhost:11434/v1`.

Anthropic does not support the OpenAI format. Its provider adapter calls the Anthropic REST API
directly (`/v1/messages`), normalising the response into `ChatChunk` internally.

OpenAI and OpenRouter both use the same request format and are called directly via `fetch()`.

### Provider interface

All providers implement the same minimal interface:

```typescript
interface Provider {
  name: string

  chat(params: {
    model: string
    messages: ChatMessage[]
    tools?: ToolDefinition[]
    system?: string
  }): AsyncIterable<ChatChunk>
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string | ContentPart[]
  /** Tool call results include the tool_use id they respond to. */
  tool_use_id?: string
}

/** Multi-modal content for vision and structured tool results. */
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/** Tool definitions passed to the LLM for function calling. */
interface ToolDefinition {
  /** Tool name — must match `[a-z_][a-z0-9_]*`. */
  name: string
  /** One-line description shown to the LLM. */
  description: string
  /** JSON Schema describing the tool's input parameters. */
  input_schema: Record<string, unknown>
}

interface ChatChunk {
  type: 'text' | 'tool_call' | 'done'
  text?: string
  toolCall?: { id: string; name: string; input: unknown }
  usage?: { inputTokens: number; outputTokens: number }
}
```

Streaming is the default. Providers that don't support streaming can emit a single
`text` chunk followed by `done`.

Each provider normalises its native format into `ChatMessage`/`ChatChunk` internally.
Provider-specific features (e.g. Anthropic's native `tool_use` blocks, OpenAI's
`function_calling`) are mapped to these common types by the provider adapter.

### Environment variables

Each provider reads its credentials from standard environment variables:

| Provider    | Variables                                         |
|-------------|---------------------------------------------------|
| Ollama      | `OLLAMA_BASE_URL` (default: `http://localhost:11434`) |
| Anthropic   | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`         |
| OpenAI      | `OPENAI_API_KEY`, `OPENAI_BASE_URL`               |
| OpenRouter  | `OPENROUTER_API_KEY`                              |

### Per-agent model override

Model can be set in `loom.yml` per agent and overridden at runtime:

```yaml
agents:
  - name: researcher
    model: "${RESEARCHER_MODEL:-anthropic/claude-sonnet-4-6}"
```

This lets operators override models via environment without changing the config file.
Useful for cost control (`export RESEARCHER_MODEL=qwen3.5:9b` to go local).

### Token budget and cost tracking (future)

v1 does not implement token counting or cost tracking. Each agent's log includes
usage metadata from the provider response, so cost can be computed offline:

```sh
# Total tokens used by researcher today
jq '[.usage.inputTokens + .usage.outputTokens] | add' \
  ~/.loom/agents/researcher/logs/2026-03-25.ndjson
```

A future `loom cost` command can aggregate this.

## Consequences

**Good:**
- Single model string in `loom.yml` — no separate provider config file
- Local-first default: no config needed for Ollama, which covers the common development case
- Environment variable overrides mean the same `loom.yml` works in dev (local) and
  prod (remote) by changing env vars at deployment
- Provider interface is minimal — adding a new provider is ~50 lines of code
- Custom providers can be registered via `loom.config.ts` (ADR-006)

**Bad:**
- Model string format is non-standard — operators used to HuggingFace hub IDs or
  Ollama's format will need to learn the prefix convention
- No automatic fallback from remote to local if the remote provider is down.
  Operators must handle this via model selection at deployment time.
- Provider credentials in environment variables means they are visible to all
  processes on the machine. Not a concern for homelab; is a concern for shared servers.

**Ollama multi-model thrashing (local GPU setups):**
Ollama loads one model into VRAM at a time by default. When multiple agents use different
models concurrently, Ollama swaps models in and out on every request — each swap can take
5–30 seconds depending on model size and hardware. Under sustained load the system spends
more time swapping than generating, effectively serializing all agents.

Mitigation options:
- **Use one model for all agents** — the simplest and most reliable approach for single-GPU
  setups. A model capable enough for the heaviest task works fine for lighter ones.
- **Increase `OLLAMA_MAX_LOADED_MODELS`** — if VRAM permits, Ollama can keep multiple models
  loaded simultaneously (default: 1 on GPU). Set to 2–3 to eliminate thrashing when running
  agents on different models.

Recommended deployment patterns:

| Setup | Recommendation |
|---|---|
| Single GPU (homelab) | One shared Ollama model for all agents |
| Multi-GPU | Multiple Ollama models, `OLLAMA_MAX_LOADED_MODELS` tuned to GPU count |
| Mixed local + cloud | Local Ollama for lightweight/frequent agents, cloud (Anthropic, OpenRouter) for agents that need stronger reasoning or have low traffic — avoids burning cloud budget on routine tasks |
| Cloud only | Any provider mix, no thrashing concern |

The mixed local + cloud pattern is well-supported by the prefix routing: triage and notification
agents run `qwen2.5:3b` locally at zero cost, while a research agent is pointed at
`anthropic/claude-sonnet-4-6` for tasks where quality matters.

## Alternatives considered

**Unified OPENAI_BASE_URL approach:** Point everything at an OpenAI-compatible endpoint
(LiteLLM proxy, Ollama's OpenAI mode). Simple for operators. But loses provider-specific
features (Anthropic tool use format, streaming differences). Rejected as the primary
model; supported as an escape hatch via `OPENAI_BASE_URL`.

**Separate provider config section in loom.yml:** A `providers:` block defining
named providers, then referencing them from agents. More explicit but verbose for the
common case of one provider per agent. Rejected in favour of prefix-in-model-string.

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-25 | Initial draft. |
| 2026-04-01 | **Provider implementation details.** All providers use plain `fetch()` — no SDKs. Ollama native `/api/chat`, Anthropic `/v1/messages`, OpenAI-compatible escape hatch. Added Ollama multi-model thrashing guidance and deployment pattern table. |
| 2026-04-03 | **Defined missing types.** Added `ContentPart` (text, image, tool_use, tool_result), `ToolDefinition` (name, description, input_schema), and `tool_use_id` on `ChatMessage`. Noted that providers normalise native formats into these common types. |
