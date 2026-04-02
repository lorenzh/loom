# ADR-009: Message origin tracking for multi-agent pipeline correlation

**Status:** Draft
**Date:** 2026-04-02

---

## Context

When multiple agents form a pipeline — fan-out to several workers, fan-in to an
aggregator — there is no way to correlate messages that belong to the same
logical run. Consider an issue-triage workflow:

```
webhook
  → new-issue-receiver
    → duplicate-checker-semantic  ─┐
    → duplicate-checker-technical ─┼→ duplicate-aggregator → ...
    → duplicate-checker-historical─┘
```

If two issues arrive near-simultaneously, the aggregator receives six checker
results in its inbox. It has no reliable way to group the three results that
belong to issue A vs issue B.

The existing `in_reply_to` field tracks only the immediate parent message (one
hop). It cannot trace back to the original trigger across multiple hops.

## Decision

Add an optional `origin` field to the `Message` interface:

```typescript
export interface Message {
  v: typeof MESSAGE_VERSION;
  id: string;
  from: string;
  ts: number;
  body: string;
  in_reply_to?: string;
  /** Slash-delimited path of message filenames tracing this pipeline run. */
  origin?: string;
}
```

### Propagation rules

The **runner** builds the `origin` path when writing to `outbox/`. The pipe
engine copies messages faithfully without modifying `origin`.

1. **Trigger message** (no incoming message, e.g. a webhook calling `send()`):
   `origin` is omitted. The message's own filename *is* the origin root.

2. **Downstream message** (agent processing an incoming message and sending
   onward): `origin` is set by appending the incoming message's filename to
   the incoming message's `origin` (if present), separated by `/`:
   ```
   origin = incoming.origin
     ? incoming.origin + "/" + incoming.filename
     : incoming.filename
   ```

3. `in_reply_to` is unchanged — it still tracks the immediate parent filename
   for restart recovery and single-hop reply threading.

### What the path tells you

The first segment is always the **root message** — the trigger that started
the pipeline. Subsequent segments record each hop. This gives you:

- **Grouping** — `origin.split('/')[0]` extracts the root for fan-in grouping
- **Full trace** — the complete path shows every message that led here
- **Agent involvement** — each message file contains a `from` field, so the
  path implicitly records which agents participated

### Example flow

```
webhook → send() creates "1743567200000-abc123.msg"
          origin: (absent — this IS the origin root)

new-issue-receiver processes "1743567200000-abc123.msg", writes to outbox:
          origin: "1743567200000-abc123.msg"
          in_reply_to: "1743567200000-abc123.msg"

duplicate-checker-semantic processes "1743567300000-def456.msg", writes to outbox:
          origin: "1743567200000-abc123.msg/1743567300000-def456.msg"
          in_reply_to: "1743567300000-def456.msg"

duplicate-aggregator processes "1743567400000-ghi789.msg", writes to outbox:
          origin: "1743567200000-abc123.msg/1743567300000-def456.msg/1743567400000-ghi789.msg"
          in_reply_to: "1743567400000-ghi789.msg"
```

In a fan-out, all 3 checkers receive the same inbox message, so their origin
paths share the same prefix. The aggregator can group by the root segment
and distinguish which checker replied via the `from` field.

### Observability

Standard Unix tools can trace an entire pipeline run:

```sh
# Find all messages related to one pipeline run (root message ID)
grep -r "1743567200000-abc123" ~/.loom/agents/*/inbox/
grep -r "1743567200000-abc123" ~/.loom/agents/*/outbox/

# Group aggregator inbox by root origin (first path segment)
jq -s 'group_by(.origin | split("/")[0])' ~/.loom/agents/duplicate-aggregator/inbox/*.msg

# Trace the full path of a specific message
jq '.origin' ~/.loom/agents/duplicate-aggregator/outbox/1743567500000-jkl012.msg
# → "1743567200000-abc123.msg/1743567300000-def456.msg/1743567400000-ghi789.msg"
```

### Fan-in / merge semantics

An aggregator agent can use `origin` to collect related messages:

- Read all pending messages from inbox
- Group by root origin (`.origin | split("/")[0]`)
- For each complete group (e.g. 3 of 3 checker results), proceed

### Failure signaling through the outbox

When an agent fails to process a message, the failure must be communicated
downstream through the same channel as success — the outbox. The runner
handles this:

1. **Graceful failure** — the runner catches the error, moves the message to
   `inbox/.failed/` (with a companion `.error.json` for local debugging), and
   writes a **failure reply** to `outbox/` with the correctly built `origin`
   path and `in_reply_to`, plus `"error": true` in the body.

2. **Hard crash** — the supervisor detects the crash and runs recovery. For any
   message stuck in `inbox/.in-progress/` that will not be retried (restart
   attempts exhausted), the supervisor writes a failure reply to the crashed
   agent's `outbox/`.

The pipe engine then forwards failure replies downstream like any other
message. The aggregator sees all expected responses — some successes, some
failures — and can decide how to proceed. No timeouts and no cross-agent
directory observation required.

```
duplicate-checker-semantic fails processing "1743567300000-def456.msg":
  1. Runner moves message to inbox/.failed/ (local debug artifact)
  2. Runner writes to outbox/:
     {
       "origin": "1743567200000-abc123.msg/1743567300000-def456.msg",
       "in_reply_to": "1743567300000-def456.msg",
       "body": "{\"error\": true, \"reason\": \"model timeout\"}"
     }
  3. Pipe engine copies this to duplicate-aggregator/inbox/
  4. Aggregator groups by root origin, sees 3 of 3 (2 success + 1 error)
```

**Key principle:** `.failed/` is a local debug artifact (visible via `ls`,
contains stack traces in `.error.json`). The outbox is the only inter-agent
communication channel — for both success and failure.

## Consequences

**Good:**
- Multi-agent pipelines become traceable end-to-end with `grep`
- Fan-in agents can correctly group concurrent pipeline runs
- Path-based origin shows which agents were involved at each hop
- No new runtime dependencies — `origin` is just a string field
- Backward compatible — `origin` is optional, existing messages still valid
- `isMessage()` validation only needs a minor addition for the new field
- The runner owns origin propagation — the pipe engine copies faithfully

**Bad:**
- The runner must build the `origin` path when writing to outbox. If a
  custom runner forgets, downstream tracing breaks. Mitigated: the standard
  `AgentRunner` handles this automatically.
- Origin paths grow with each hop (~40 chars per segment). For pipelines
  of 3-5 hops this is negligible. Deeply nested pipelines (10+ hops) may
  want to consider truncation.

## Alternatives considered

**Per-pipeline subdirectories** (`inbox/issue-42/`): More observable with `ls`
but changes the inbox contract. Every tool that reads the inbox would need to
handle nested directories. Rejected — too invasive for what is a metadata
problem.

**Correlation ID as a separate concept:** A dedicated `correlation_id` field
decoupled from the message filename. Adds a new concept when the filename
already provides a unique, timestamp-sortable identifier. Rejected — reuse
what exists.

**Body-level tracking only:** Put the origin in the `body` JSON payload instead
of a top-level field. Works but makes it invisible to the runtime and harder to
query generically. Rejected — the runtime should know about pipeline identity.

---

## Changelog

| Date | Change |
|---|---|
| 2026-04-02 | Initial draft. |
| 2026-04-02 | Replaced `.failed/` observation with outbox-based failure signaling. |
| 2026-04-02 | Changed `origin` from flat filename to slash-delimited path. Runner owns propagation; pipe engine copies faithfully. |
