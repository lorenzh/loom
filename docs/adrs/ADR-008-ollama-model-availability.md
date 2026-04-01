# ADR-008: Ollama model availability — fail fast with actionable error

**Status:** Accepted
**Date:** 2026-04-01

---

## Context

When an agent is configured to use a local Ollama model (e.g. `qwen2.5:3b`), the model must
be pulled before it can be used (`ollama pull qwen2.5:3b`). If the model is not present,
Ollama returns an HTTP 404 with a JSON body containing `"model not found"`.

Without explicit handling this surfaces as an unstructured HTTP error that gives the operator
no clear indication of what went wrong or how to fix it.

## Decision

The Ollama provider adapter checks the response status before attempting to parse the stream.
If Ollama returns a 404 with a model-not-found body, the runner throws a structured
`ModelNotFoundError` immediately — no retry, no auto-pull.

The error message is actionable:

```
Model 'qwen2.5:3b' is not available in Ollama.
Run: ollama pull qwen2.5:3b
```

The crash record written to `crashes/` uses `error_type: "model_not_found"`:

```json
{
  "ts": "2026-04-01T21:00:00.000Z",
  "exitCode": null,
  "signal": null,
  "restartCount": 0,
  "nextRestartAt": null,
  "error_type": "model_not_found",
  "last_error": "Model 'qwen2.5:3b' is not available in Ollama. Run: ollama pull qwen2.5:3b"
}
```

loom does **not** auto-pull the model. Pulling a model can take minutes and consume gigabytes
of disk — this is an explicit operator action, not something a runtime should trigger silently.

## Consequences

**Good:**
- Operators see exactly what went wrong and the precise command to fix it
- No surprising disk usage or long pauses triggered by the runtime
- `error_type: "model_not_found"` is machine-readable — tooling can detect and surface it

**Bad:**
- First-time operators must know to run `ollama pull` before starting agents. The error
  message covers this, but it is still one extra step compared to auto-pull.

## Alternatives considered

**Auto-pull on first use:** Convenient but hides a real configuration problem, consumes
disk silently, and can stall agent startup for minutes with no visible feedback. Rejected.

**Generic HTTP error passthrough:** Surfaces as an opaque `fetch` error. Operators would
need to read Ollama logs to understand the cause. Rejected — the runtime has enough context
to produce a better message.

---

## Changelog

| Date | Change |
|---|---|
| 2026-04-01 | Initial decision. |
