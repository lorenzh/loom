# Pipe engine — wiring agent outboxes to inboxes

**Status:** Draft
**Date:** 2026-03-26

---

## Context

Agents need to communicate with each other. The filesystem layout provides
`inbox/` and `outbox/` directories per agent. But something needs to move
messages from one agent's outbox to another agent's inbox.

loom.yml already supports declaring pipes:

```yaml
agents:
  - name: writer
    pipes:
      - from: researcher    # researcher outbox → writer inbox
```

This ADR specifies how the pipe engine works internally: how it watches for
new outbox messages, how it copies them, how it handles failures, and how
it avoids duplication.

## Decision

### The pipe is a filesystem watcher

The pipe engine runs inside the supervisor process. For each declared pipe,
it watches the source agent's `outbox/` directory and copies new `.msg` files
to the destination agent's `inbox/`.

```
researcher/outbox/               writer/inbox/
  1742900000000-01HX.msg   →      1742900000000-01HX.msg
  1742910000000-01HY.msg   →      1742910000000-01HY.msg
```

### Message identity and deduplication

Each `.msg` file has a globally unique name: `<timestamp>-<ulid>.msg`.

- `timestamp` — Unix milliseconds at message creation
- `ulid` — [ULID](https://github.com/ulid/spec) for uniqueness within the same millisecond

When the pipe engine copies a message, it preserves the original filename.
The destination agent's inbox watcher uses the filename as the deduplication key.

A pipe tracking file at `$LOOM_HOME/pipes/<from>-<to>.jsonl` records all
forwarded messages. On restart, the pipe engine reads this log to skip
already-forwarded messages.

```
$LOOM_HOME/pipes/
  researcher-writer.jsonl   ← append-only log of forwarded message IDs
```

Each line: `{"msg":"1742900000000-01HX","at":"2026-03-26T05:01:00Z"}`

### Cursor-based scanning

To avoid scanning the entire outbox on every poll cycle, the pipe engine
maintains a **cursor** per pipe — the filename of the last forwarded message.
Since filenames use `{timestamp_ms}-{ulid}.msg` format and ULIDs sort
lexicographically, the cursor is a simple string comparison:

```
cursor = "1742900000000-01JBABC"

readdir(outbox/)
  .filter(f => f > cursor)    // only files newer than cursor
  .sort()                     // oldest first
  // forward each, update cursor
```

The cursor is the last entry in the tracking JSONL — no separate file needed.
On supervisor restart, the pipe engine reads the last line of each tracking
file to restore its cursor position.

### Pipes require a supervisor

The pipe engine only runs inside the supervisor process. Pipes are active
when agents are managed via `loom up` or `loom run --detach` (see ADR-006).

Foreground agents (`loom run` without `--detach`) have no pipe engine. For
one-off piping in this mode, operators can use shell tools:

```sh
loom read researcher --follow | loom send writer --stdin
```

### Copy vs. symlink

Options for forwarding:
1. **Hard copy** — a real copy of the file in the destination inbox
2. **Symlink** — `inbox/file.msg → ../../researcher/outbox/file.msg`
3. **Hard link** — same inode, two directory entries

Decision: **copy**. Reasons:
- The source file may be deleted (e.g., by the researcher's GC) while the
  destination agent hasn't processed it yet. A copy is immune.
- Symlinks add indirection; if the target moves, they break.
- Hard links don't work across filesystems (edge case, but possible).
- Cost: minimal — messages are small text files.

The copy algorithm with deduplication:

```
For each .msg file in source outbox/ (newer than cursor):
  1. Does file exist in destination inbox/?              → skip
  2. Does file exist in destination inbox/.processed/?   → skip
  3. Does file exist in destination inbox/.in-progress/? → skip
  4. Is filename in tracking log?                        → skip
  5. Write to destination inbox/{filename}.tmp            (atomic write)
  6. Rename .tmp → .msg                                  (atomic commit)
  7. Append filename to tracking log                     (durable record)
  8. Update cursor
```

If the supervisor crashes between step 6 and 7, the next startup detects the
file already in the destination inbox (step 1) and skips it. No duplicates.

### Pipe declaration

In `loom.yml`:

```yaml
agents:
  - name: researcher
    model: qwen3.5:9b

  - name: writer
    model: qwen3.5:9b
    pipes:
      - from: researcher           # all messages
      - from: analyst
        filter: '.priority == "high"'   # jq expression — only high-priority
```

Pipes can also be declared at the top level:

```yaml
agents:
  - name: researcher
  - name: writer
  - name: archiver

pipes:
  - from: researcher
    to: writer
  - from: researcher
    to: archiver
    filter: '.type == "finding"'
```

### Dynamic pipes via CLI

```sh
# Wire two agents together (adds to runtime pipe table, not loom.yml)
loom pipe researcher writer

# Wire with a filter
loom pipe researcher writer --filter '.priority == "high"'

# Disconnect
loom unpipe researcher writer

# List active pipes
loom pipes
```

Dynamic pipes are stored in `$LOOM_HOME/pipes/active.json`:

```json
[
  { "from": "researcher", "to": "writer", "filter": null },
  { "from": "researcher", "to": "archiver", "filter": ".type == \"finding\"" }
]
```

The supervisor loads this file on startup and reloads it when it changes (inotify/poll).

### Filtering

Filters are [jq](https://stedolan.github.io/jq/) expressions evaluated against the
message JSON. A message is forwarded only if the filter returns a truthy value.

```yaml
pipes:
  - from: inbox-triage
    to: deep-researcher
    filter: '.labels | contains(["research"])'

  - from: inbox-triage
    to: notify
    filter: '.priority == "urgent"'
```

Filter evaluation:
- Parse the `.msg` file as JSON
- Run `jq -e '<filter>' <file>`
- If exit code 0: forward. If non-zero or parse error: skip and log.

If the message file is not valid JSON, the filter is skipped and the message
is always forwarded (conservative default).

### Transform

A pipe can optionally transform the message before forwarding:

```yaml
pipes:
  - from: researcher
    to: writer
    transform: '{ message: .result, source: "researcher", ts: .completed_at }'
```

Transform is a jq expression that maps the original message to a new shape.
The transformed message is written to the destination inbox, not the original.

### Fan-out and fan-in

**Fan-out** (one source, multiple destinations) — declare multiple pipes with the
same `from`. Each destination receives its own copy:

```yaml
pipes:
  - from: researcher
    to: writer
  - from: researcher
    to: archiver
```

**Fan-in** (multiple sources, one destination) — declare multiple pipes with the
same `to`. The destination inbox receives messages from all sources, interleaved
by arrival time:

```yaml
pipes:
  - from: researcher
    to: consolidator
  - from: analyst
    to: consolidator
```

### Origin preservation

When the pipe engine copies a message from one agent's outbox to another's
inbox, it preserves the `origin` field as-is. The pipe engine does **not**
modify `origin` — that is the runner's responsibility (see ADR-009).

The runner builds the `origin` path when writing to outbox by appending the
inbox message's filename to the existing origin. The pipe engine simply
copies the message faithfully, including whatever `origin` the runner set.

When a pipe applies a **transform**, the `origin` field is always preserved
from the original message, even if the jq transform does not include it.

### Failure reply forwarding

The pipe engine forwards failure replies the same as any other outbox message.
There are two sources of failure replies:

1. **Runner-generated** — when an agent fails to process a message, the runner
   writes a failure reply to the agent's outbox (with `error: true` and the
   correctly built `origin` path).

2. **Supervisor-generated** — when an agent hard-crashes and has exhausted its
   restart attempts, the supervisor writes failure replies to the crashed
   agent's outbox for any messages stuck in `inbox/.in-progress/`.

In both cases, the failure reply appears in the outbox like a normal message.
The pipe engine copies it downstream. The receiving agent (e.g. a fan-in
aggregator) sees all expected responses — successes and failures — and can
decide how to proceed without timeouts or cross-agent directory observation.

### Error handling

**Destination agent not running:** the pipe engine writes to the inbox regardless.
Messages wait in the inbox until the agent starts. Inbox messages are durable.

**Destination agent inbox does not exist:** this means the agent directory has not
been initialised yet. The pipe engine retries with exponential backoff (1s, 2s, 4s,
up to 30s). After 5 minutes of failures, it logs an error and pauses the pipe.

**Filter evaluation failure:** logged, message skipped (not forwarded, not lost —
recorded as `skipped` in the pipe tracking log).

**Transform failure:** logged, original (untransformed) message forwarded instead.
Fail-safe default.

### Pipe status

```sh
loom pipes

PIPE               FILTER                   FORWARDED   LAST
researcher→writer  none                     142         5s ago
researcher→archive .type == "finding"       31          2m ago
analyst→writer     none                     18          12m ago
```

The pipe tracking log (`pipes/<from>-<to>.jsonl`) is the source of truth for counts.

### Pipe with no supervisor

The pipe engine only runs inside the supervisor. If running without the supervisor
(e.g., scripted one-shot use), use Unix pipes instead:

```sh
# Manual pipe: researcher output → writer input
loom read researcher --follow | loom send writer --stdin
```

### Pipe operators

A pipe can include **operators** — stateless or stateful processing steps that
sit between the source outbox and the destination inbox. Operators compose
into a pipeline via the `through` key.

#### Operators are directories

Each operator instance is a filesystem-backed directory, consistent with
loom's "everything is a file" principle:

```
$LOOM_HOME/pipes/researcher→writer/
  pipeline.json       # operator chain definition
  log.jsonl           # pipe-level tracking log
  operators/
    0-filter/
      type            # "filter"
      config.json     # { "expr": ".type == \"finding\"" }
      inbox/          # messages arrive here from previous stage
      outbox/         # messages emitted to next stage
      state/          # operator working state (if stateful)
    1-window/
      type            # "window"
      config.json     # { "size": 5, "timeout_ms": 30000 }
      inbox/
      outbox/
      state/
        pending/      # messages buffered in the current window
        cursor        # last flush timestamp
```

The prefix (`0-`, `1-`, ...) encodes pipeline order. Each operator reads
from its `inbox/`, processes, and writes to its `outbox/`. The pipe engine
wires adjacent stages: operator N's `outbox/` feeds operator N+1's `inbox/`.
The first operator's inbox is fed from the source agent's outbox; the last
operator's outbox feeds the destination agent's inbox.

All operator state is inspectable with standard Unix tools:

```sh
# How many messages are buffered in the window?
ls pipes/researcher→writer/operators/1-window/state/pending/ | wc -l

# What's the filter config?
cat pipes/researcher→writer/operators/0-filter/config.json

# Watch messages flow through a stage
tail -f pipes/researcher→writer/operators/0-filter/outbox/
```

#### Built-in operators

The pipe engine ships with a set of built-in operators. Each is implemented
as a function inside the supervisor, but follows the same filesystem contract
(inbox → process → outbox) so that scriptable operators can replace or extend
them in the future.

| Operator | Stateful | Description |
|---|---|---|
| **filter** | No | Pass or drop messages. jq expression evaluated per message. |
| **transform** | No | Reshape message JSON. jq expression maps input → output. |
| **split** | No | One message → N messages. jq expression returns an array; each element becomes a separate message. |
| **route** | No | Conditional fan-out. Maps jq predicates to named output channels (see below). |
| **tap** | No | Copy every message to a side-channel directory for observability; original continues downstream. |
| **window** | Yes | Collect messages by count or time, emit as a single batch message. |
| **buffer** | Yes | Hold messages until a condition (jq predicate on the buffer contents) is met, then flush. |
| **dedupe** | Yes | Drop duplicates by a jq key expression. Maintains a seen-keys set in `state/`. |
| **throttle** | Yes | Rate-limit: forward at most N messages per T seconds. Excess messages wait in `state/pending/`. |
| **accumulate** | Yes | Fold messages into a running value. jq expression `(state, message) → new_state`. Emits the new state downstream on each input. |

#### Pipeline composition in loom.yml

Simple pipes (no operators) keep the existing syntax:

```yaml
pipes:
  - from: researcher
    to: writer
    filter: '.priority == "high"'
```

For multi-stage pipelines, use `through`:

```yaml
pipes:
  - from: researcher
    to: writer
    through:
      - filter: '.type == "finding"'
      - dedupe: '.id'
      - window: { size: 5, timeout: 30s }
      - transform: '{ findings: [.[].result], count: length }'
```

Each entry in `through` is `{ operator_type: config }`. The pipe engine
creates the operator directories automatically when the supervisor starts.

When `through` is present, top-level `filter` and `transform` keys are
not allowed (use them inside `through` instead).

#### Route operator

Route is a special operator that enables conditional fan-out within a
single pipe declaration:

```yaml
pipes:
  - from: inbox-triage
    route:
      - when: '.labels | contains(["research"])'
        to: deep-researcher
      - when: '.priority == "urgent"'
        to: notify
      - otherwise: archive
```

A message can match multiple routes (all matching branches receive a copy).
`otherwise` catches messages that match no `when` clause.

Under the hood, route creates one output channel per branch, each wired to
the destination agent's inbox. The filesystem layout:

```
$LOOM_HOME/pipes/inbox-triage→[routed]/
  operators/
    0-route/
      config.json
      inbox/
      outbox/
        deep-researcher/    # messages matching research route
        notify/             # messages matching urgent route
        archive/            # otherwise
```

#### Stateful operator recovery

Stateful operators (window, buffer, dedupe, throttle, accumulate) store
their working state in the `state/` directory:

- **window/buffer**: pending messages are files in `state/pending/`.
  On supervisor restart, the operator resumes with whatever is in `pending/`.
  If `timeout` has elapsed, it flushes immediately.
- **dedupe**: seen keys stored in `state/seen.jsonl` (append-only).
  GC truncates after a configurable TTL.
- **throttle**: rate window timestamps in `state/window.json`.
- **accumulate**: current fold state in `state/current.json`.

Because state is files, recovery after a crash is automatic — the operator
picks up where it left off by reading its `state/` directory.

#### Origin through pipelines

Operators preserve the `origin` field by default. Stateless operators
(filter, transform, tap) pass it through unchanged. Stateful operators
that emit batch messages (window, buffer, accumulate) set `origin` to an
array of the constituent messages' origins.

#### Future: scriptable operators

The built-in operator set is designed to be replaceable. A future extension
will allow operators to be external scripts or executables:

```yaml
through:
  - script: ./operators/my-custom-op.sh
    config: { threshold: 42 }
```

The contract: the script reads `.msg` files from its `inbox/`, writes `.msg`
files to its `outbox/`, and manages its own `state/`. The pipe engine
handles wiring and lifecycle. This is not yet implemented.

## Consequences

### Good

**Durable.** Messages in the inbox survive supervisor restarts and crashes. The pipe
tracking log prevents re-delivery after recovery.

**Observable.** The pipe tracking log is an append-only file. `tail -f` it.
The `loom pipes` command shows live counts without a daemon query. Operator state
is inspectable with `ls`, `cat`, `wc -l` — no special tooling needed.

**No message broker required.** The filesystem is the broker. No Redis, no Kafka,
no RabbitMQ. Works offline.

**Composable.** jq filters and transforms are standard and testable:
```sh
echo '{"priority":"high","type":"finding"}' | jq '.priority == "high"'
# true
```

**Fan-out is free.** One source agent can feed N destinations with zero extra
protocol — just N copy operations.

**Operators are files too.** Stateful operators (window, buffer, dedupe, throttle,
accumulate) store all state as files in their `state/` directory. No hidden
in-memory state. Crash recovery is automatic — read the directory, resume.

**Pipeline composition without complexity.** The `through` syntax is declarative
and linear. Each operator has a clear filesystem footprint. Debugging a pipeline
means inspecting directories in order.

**Extensible by design.** Built-in operators follow the same filesystem contract
(inbox/outbox/state) that future scriptable operators will use. No separate
protocol for built-ins vs. plugins.

### Tricky

**Polling latency.** The inbox watcher uses polling (ADR-003). On Linux, inotify
could be used for sub-100ms latency. On macOS/Linux both, kqueue/inotify are
optional acceleration. Default polling interval is 500ms — acceptable for most
agent pipelines.

**jq dependency.** Filters and transforms require `jq` installed on the host.
We bundle a jq WASM build as fallback so the runtime has no hard dependency.

**Pipe tracking log grows unboundedly.** Each forwarded message appends one line.
At 10 messages/minute over 24 hours: ~14,400 lines, ~1MB. GC rotates these after
7 days. The `loom gc` command handles this.

**No ordering guarantee across fan-in.** When multiple sources pipe to one
destination, message order depends on file arrival time. Agents receiving
fan-in messages should not assume ordering.

**Transform failures are silent from the recipient's perspective.** The writer
receives the untransformed message. This could be confusing. Mitigation: add
a `_pipe_transform_failed: true` field to forwarded messages when transform
fails, so the recipient can detect it.

**Stateful operator state grows.** Dedupe seen-keys, throttle windows, and
accumulator state can grow over time. Each stateful operator should define a
GC policy (e.g., dedupe TTL, throttle window rotation). `loom gc` handles this.

**Pipeline debugging.** With multiple operators, a message that doesn't arrive
at the destination could be stuck at any stage. Mitigation: `loom pipes --verbose`
shows per-operator counts and the `tap` operator can be inserted at any point
for live inspection.

## Alternatives Considered

### Message broker (Redis, NATS, etc.)

Persistent, high-throughput, supports pub/sub and queues. Rejected: requires
a running service, not local-first, adds operational complexity. For the
use cases loom targets (single-machine, tens of agents), filesystem I/O is
sufficient.

### Shared inbox (one inbox directory for multiple agents)

Simpler than N copies. Rejected: agents would need to coordinate reads,
adding concurrency complexity. The current model gives each agent a private
inbox with no coordination needed.

### Agent-to-agent direct API call

Agent A calls an HTTP endpoint on Agent B. Rejected: requires agents to be
network services, adds port management, loses durability (message lost if
recipient is down), breaks the filesystem-as-protocol principle.

### Streaming (tail -f style)

The source agent writes to a named FIFO or socket; the destination reads it.
Rejected: FIFOs block on write if the reader is not running, and messages
are lost on reader crash. File-based inbox is durable.

## References

- ADR-003: Inbox watcher via polling — the mechanism the pipe engine relies on
- ADR-009: Message origin tracking — `origin` field propagated by the pipe engine
- [ULID spec](https://github.com/ulid/spec) — sortable unique IDs for messages
- [jq manual](https://stedolan.github.io/jq/manual/) — filter/transform language
- Unix pipes — the conceptual model, applied to persistent agent communication

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-26 | Initial draft. |
| 2026-04-02 | **Added origin preservation.** Pipe engine copies `origin` faithfully — runner owns propagation (ADR-009). Origin is always preserved through transforms. |
| 2026-04-02 | **Added failure reply forwarding.** Pipe engine forwards runner- and supervisor-generated failure replies like any other outbox message. |
| 2026-04-02 | **Removed `in_reply_to` references.** Failure replies use `origin` path and top-level `error` field instead (ADR-009). |
| 2026-04-02 | **Added pipe operators.** Operators (filter, transform, split, route, tap, window, buffer, dedupe, throttle, accumulate) as filesystem-backed directories with inbox/outbox/state. Pipeline composition via `through` key. Built-in first, scriptable later. |
