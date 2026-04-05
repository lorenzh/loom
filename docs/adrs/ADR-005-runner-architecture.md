# ADR-005: Runner architecture

**Status:** Accepted
**Date:** 2026-03-30

---

## Context

The loom runtime (ADR-001 through ADR-004) defines agents as Unix processes with
filesystem-backed state, inbox polling, and supervisor-managed lifecycle. What is
missing is the specification of what actually runs inside an agent process — the
component that reads messages, calls an LLM, executes tools, and writes responses.

This component is the **runner**. Its architecture determines:
1. How tightly coupled agents are to the supervisor
2. Whether agents can operate standalone (without a supervisor)
3. Who owns filesystem state (status, logs, outbox)
4. How message processing failures are handled
5. How tool execution works

## Decision

### The runner is a self-sufficient process

A runner is an OS process that manages a single agent's complete lifecycle:
reading its inbox, calling the LLM, executing tools, writing responses, and
maintaining its own state files. It does not depend on the supervisor for
message dispatch or state management.

```
Runner (one per agent)
  ├── polls inbox/ via InboxWatcher (ADR-003)
  ├── builds prompt (system prompt + memory + conversation history + message)
  ├── calls LLM via provider (model routing)
  ├── executes tools (spawns plugin executables)
  ├── writes response to outbox/
  ├── writes conversation history to logs/
  ├── updates status file (running, idle)
  └── moves processed messages through inbox lifecycle
```

### Relationship to supervisor

The supervisor (ADR-004) is a **process manager and message router**. It
spawns runners and pipe processes, detects crashes, restarts with backoff,
and routes messages between agents and pipes by watching outbox directories
and copying `.msg` files to inbox directories (see ADR-010). It does NOT
own agent state or mediate message processing — runners and pipe processes
handle their own inbox/outbox lifecycle independently.

| Responsibility | Owner |
|---|---|
| Inbox consumption | Runner |
| LLM interaction | Runner |
| Tool execution | Runner |
| Outbox writes | Runner |
| Status updates (`running`, `idle`) | Runner |
| Logs and conversation history | Runner |
| Crash records | Supervisor |
| Restart logic and backoff | Supervisor |
| Message routing (outbox → inbox copies) | Supervisor |
| Pipe process management | Supervisor |
| Status updates (`restarting`, `dead`) | Supervisor |

### Three-phase message processing

The runner processes messages through three filesystem phases (see ADR-003):

```
1. Pick oldest .msg from inbox/
2. Move to inbox/.in-progress/        — "I'm working on this"
3. Call LLM, execute tools
4. Write response to outbox/          — origin path includes inbox filename
5. Move from .in-progress/ to .processed/  — "Done"
```

### Sequential processing

Messages are processed one at a time (FIFO). `InboxWatcher` may emit multiple
filenames in a single poll cycle (all files found in inbox/). The runner uses an
internal drain queue: filenames are enqueued on each `message` event and drained
one at a time. This ensures only one LLM call is in flight per agent at any time
and keeps status transitions (`running` / `idle`) consistent.

### Outbox reply format

Responses are written with `sendReply(root, agent, body, inReplyTo)`. The `from`
field is always the agent's own name — no separate `from` parameter is needed.

### Idempotent restart recovery

On startup, the runner checks `inbox/.in-progress/` for messages that were
mid-processing when it last crashed:

```
for each file in inbox/.in-progress/:
  scan outbox/ for any message whose origin ends with this filename
  if found → response already written
    → move from .in-progress/ to .processed/ (finish the ack)
  if not found → processing did not complete
    → move back to inbox/ for reprocessing
```

This provides at-least-once delivery with no duplicate responses.

### Tool execution

The runner executes tools directly by spawning plugin executables.
When the LLM requests a tool call:

1. Runner looks up the tool's executable path (provided at init time)
2. Spawns the plugin: `echo '<input_json>' | <plugin_path> invoke`
3. Reads the JSON result from stdout
4. Sends the result back to the LLM as a tool response

If the plugin crashes (non-zero exit, timeout), the runner constructs an error
tool result and sends it to the LLM. The LLM decides how to handle it (retry,
try a different approach, respond without the tool).

### Error handling

**LLM call failures:**

| Error type | Action |
|---|---|
| Transient (timeout, rate limit, 5xx) | Retry with exponential backoff (1s, 2s, 4s). Max 3 retries. |
| Permanent (401 unauthorized, 400 bad request) | Don't retry. |
| All retries exhausted | Write failure reply to `outbox/` with `error: true`, building `origin` path per ADR-009 (**first**, for crash safety). Then move message to `inbox/.failed/` with companion `.error.json`. Log error. |

**Tool execution failures:**

Tool errors are sent back to the LLM as error tool results. The LLM handles
them as part of its normal tool-use flow. The runner does not retry tool calls —
that is the LLM's decision.

### Incoming error messages

Messages with `"error": true` in the body are **pipeline failure signals** from
upstream agents (see ADR-009). They arrive via the normal pipe runner flow and
indicate that an upstream agent failed to process a message in the same pipeline
run.

Error messages are processed through the LLM like any other message. The LLM
decides how to handle failures — for example, a fan-in aggregator's prompt can
instruct the LLM to proceed with partial results when error messages are
present in a group. The runner does not special-case error messages.

### Runner modes

The same runner code supports two modes (see ADR-006):

**Foreground (`loom agent start`):** Runner starts, reads from stdin (if
`--stdin`), processes through the LLM, writes the response to stdout. Logs
and errors go to stderr. Ctrl+C stops it. No supervisor involved.

In `--stdin` mode the runner targets only the message that was just piped in.
It skips crash recovery and ignores any other messages already in the inbox.
This ensures deterministic output — the command echoes exactly what was piped,
regardless of leftover state from previous runs.

**Managed (`loom agent start --detach` or `loom up`):** Supervisor spawns
the runner as a child process. Crash recovery and message routing are active.

In both modes, the runner's internal logic is identical — only the lifecycle
management differs.

## Consequences

### Good

**Runners work standalone.** A single `loom agent start` command starts a
fully functional agent without a supervisor. This is ideal for development,
scripting, and single-agent use cases.

**Clear separation of concerns.** The runner handles agent logic; the
supervisor handles lifecycle and routing. Neither depends on the other
for its core function.

**Idempotent restart.** The `origin` last-segment check ensures no duplicate
responses after a crash, without requiring transactions or a database.

**Tool execution is transparent.** Plugins are spawned as subprocesses
with JSON on stdin/stdout. Any language, any runtime.

### Tricky

**Runner owns status writes, but so does the supervisor.** The runner
writes `running` and `idle`; the supervisor writes `restarting`, `dead`,
and `stopped`. Both write to the same `status` file. Since these
transitions don't overlap (the runner is not running when the supervisor
writes crash-related statuses), there is no race condition.

**No centralized message observability.** The supervisor does not see
messages flowing through agents in real time — it only sees the
filesystem. This is acceptable: operators observe agents via
`tail -f agents/{name}/logs/*.ndjson` or `ls agents/{name}/outbox/`.

**Tool execution is invisible to the supervisor.** Tool calls happen
inside the runner process. They appear in the agent's logs but the
supervisor has no direct visibility. This is by design — the supervisor
routes messages between agents and pipes but does not inspect or mediate
message processing within an agent.

## Alternatives considered

**Supervisor as message mediator (stdin/stdout dispatch):**
The supervisor watches inboxes, dispatches messages to runners via stdin,
and reads responses from stdout. This gives the supervisor full visibility
but makes runners dependent on the supervisor for all I/O. Runners cannot
work standalone. Rejected in favour of self-sufficient runners.

**Runner with no filesystem access (pure stdin/stdout):**
The supervisor feeds the runner everything (memory, conversation history,
tool schemas) via stdin. Maximum isolation but high protocol complexity
and tight coupling to the supervisor. Rejected.

## References

- ADR-001: Unix process model — agents are processes
- ADR-002: Filesystem as process table — directory layout and message format
- ADR-003: Inbox watcher polling — three-phase processing lifecycle
- ADR-004: Supervisor and restart policy — process management and crash recovery

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-30 | Initial decision. |
| 2026-04-01 | **Sequential processing and API cleanup.** Runner uses a drain queue for FIFO one-at-a-time processing. `sendReply` drops the `from` parameter (derived from agent name). Removed dangling plugin protocol ADR reference. |
| 2026-04-03 | **Failure signaling and supervisor alignment.** Outbox failure replies on exhausted retries (ADR-009). Error messages (`"error": true`) processed by LLM like normal messages. Supervisor described as process manager and message router (ADR-004, ADR-010). |
| 2026-04-05 | **Stdin mode targets only the piped message.** Runner accepts `targetFilename` option to skip crash recovery and ignore other inbox messages, ensuring deterministic one-shot output. |
