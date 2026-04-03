# Pipes — named, reusable message processors

**Status:** Draft
**Date:** 2026-03-26

---

## Context

Agents need to communicate with each other. The filesystem layout provides
`inbox/` and `outbox/` directories per agent. But something needs to move
messages from one agent's outbox to another agent's inbox — and optionally
filter, transform, batch, or deduplicate them along the way.

Early designs embedded pipe logic inside the supervisor. This conflated two
concerns: **message routing** (moving files between directories) and **message
processing** (filtering, transforming, windowing). It also made pipes anonymous
and non-reusable — each connection was defined inline on the agent.

This ADR redefines pipes as **named, first-class entities** — configured like
agents, backed by the filesystem, reusable across multiple connections, and
composable with each other.

## Decision

### Pipes are named entities

A pipe is a named message processor with its own directory under
`$LOOM_HOME/pipes/`. Like agents, pipes are configured in `loom.yml` and
managed by the supervisor.

```yaml
pipes:
  finding-filter:
    through:
      - filter: '.type == "finding"'
      - dedupe: '.id'
      - window: { size: 5, timeout: 30s }
      - transform: '{ findings: [.[].result], count: length }'

  urgency-gate:
    through:
      - filter: '.priority == "urgent"'
      - throttle: { max: 10, per: 60s }
```

Each pipe has a unique name matching `[a-z][a-z0-9-]*` — the same naming
rules as agents.

### Pipes are directories

Every named pipe gets a filesystem directory, consistent with loom's
"everything is a file" principle:

```
$LOOM_HOME/pipes/
  finding-filter/
    config.json         # pipe definition (through, metadata)
    status              # "active" / "paused" / "error"
    inbox/              # messages arrive here from source
    outbox/             # processed messages emitted here
    log.jsonl           # tracking log (append-only)
    operators/          # pipeline stages
      0-filter/
        type            # "filter"
        config.json     # { "expr": ".type == \"finding\"" }
        inbox/
        outbox/
        state/
      1-dedupe/
        type            # "dedupe"
        config.json     # { "key": ".id" }
        inbox/
        outbox/
        state/
          seen.jsonl
      2-window/
        type            # "window"
        config.json     # { "size": 5, "timeout_ms": 30000 }
        inbox/
        outbox/
        state/
          pending/
      3-transform/
        type            # "transform"
        config.json     # { "expr": "{ findings: ... }" }
        inbox/
        outbox/
```

The prefix (`0-`, `1-`, ...) encodes pipeline order. The pipe engine wires
adjacent stages: operator N's `outbox/` feeds operator N+1's `inbox/`. The
pipe's top-level `inbox/` feeds the first operator; the last operator's
`outbox/` feeds the pipe's top-level `outbox/`.

All state is inspectable with standard Unix tools:

```sh
# Pipe status
cat $LOOM_HOME/pipes/finding-filter/status

# Messages buffered in the window
ls $LOOM_HOME/pipes/finding-filter/operators/2-window/state/pending/ | wc -l

# Watch messages flow out of a pipe
ls $LOOM_HOME/pipes/finding-filter/outbox/

# Tracking log
tail -f $LOOM_HOME/pipes/finding-filter/log.jsonl
```

### Agents declare their inputs with `from`

Agents declare where they receive messages using the `from` key. This
replaces the old `pipes` key on agents and the old top-level `pipes`
from/to syntax.

```yaml
agents:
  - name: researcher
    model: qwen3.5:9b

  - name: writer
    model: qwen3.5:9b
    from:
      - pipe: finding-filter        # through a named pipe
        source: researcher
      - source: editor              # direct, no pipe
```

Three wiring patterns, one syntax:

**Direct (agent → agent):**
```yaml
from:
  - source: researcher              # supervisor copies outbox → inbox directly
```

**Through a pipe (agent → pipe → agent):**
```yaml
from:
  - pipe: finding-filter
    source: researcher
```

**Through chained pipes (agent → pipe → pipe → agent):**
```yaml
from:
  - pipe: batch-findings
    source: high-priority           # high-priority is a pipe, not an agent
```

### Pipe-to-pipe routing

Because pipes have `inbox/` and `outbox/` just like agents, they can be
sources for other pipes. This enables composable processing graphs:

```yaml
pipes:
  classify:
    through:
      - transform: '. + { category: (if .score > 0.8 then "high" else "low" end) }'

  high-priority:
    through:
      - filter: '.category == "high"'

  batch-findings:
    through:
      - window: { size: 10, timeout: 60s }

agents:
  - name: researcher
    model: qwen3.5:9b

  - name: writer
    model: qwen3.5:9b
    from:
      - pipe: batch-findings
        source: high-priority
```

And somewhere, `high-priority` is wired to `classify`, which is wired to
`researcher`. The full chain:

```
researcher/outbox → classify/inbox → classify/outbox
  → high-priority/inbox → high-priority/outbox
    → batch-findings/inbox → batch-findings/outbox → writer/inbox
```

Pipe-to-pipe wiring uses the same `from` syntax but on the pipe definition:

```yaml
pipes:
  classify:
    through:
      - transform: '. + { category: ... }'

  high-priority:
    from:
      - pipe: classify
        source: researcher
    through:
      - filter: '.category == "high"'

  batch-findings:
    from:
      - source: high-priority
    through:
      - window: { size: 10, timeout: 60s }
```

### Reusability

Named pipes are reusable across multiple connections:

```yaml
pipes:
  urgency-gate:
    through:
      - filter: '.priority == "urgent"'
      - throttle: { max: 10, per: 60s }

agents:
  - name: notify
    from:
      - pipe: urgency-gate
        source: inbox-triage
      - pipe: urgency-gate
        source: external-monitor
```

When a pipe is used by multiple connections, each connection gets its own
**instance** — a separate directory with independent state. The instance
directory includes the connection context in its name:

```
$LOOM_HOME/pipes/
  urgency-gate/                     # pipe definition (template)
    config.json
  urgency-gate~inbox-triage→notify/ # instance for this connection
    status
    inbox/
    outbox/
    operators/
    log.jsonl
  urgency-gate~external-monitor→notify/  # separate instance
    status
    inbox/
    outbox/
    operators/
    log.jsonl
```

The `~source→dest` suffix identifies the instance. Each instance has its own
state, cursor, and tracking log — no shared mutable state between connections.

### The supervisor is a message router

The supervisor's role is **routing only** — it watches outbox directories and
copies messages to inbox directories. It does not contain pipe logic.

The supervisor maintains a **routes table** derived from `loom.yml` at startup:

```
$LOOM_HOME/routes.json
```

```json
[
  { "source": "researcher", "sourceType": "agent", "pipe": null, "dest": "editor", "destType": "agent" },
  { "source": "researcher", "sourceType": "agent", "pipe": "finding-filter", "dest": "writer", "destType": "agent" },
  { "source": "researcher", "sourceType": "agent", "pipe": "classify", "dest": "high-priority", "destType": "pipe" },
  { "source": "high-priority", "sourceType": "pipe", "pipe": null, "dest": "batch-findings", "destType": "pipe" },
  { "source": "batch-findings", "sourceType": "pipe", "pipe": null, "dest": "writer", "destType": "agent" }
]
```

For each route, the supervisor:
1. Watches the source's `outbox/` (agent or pipe)
2. Copies new `.msg` files to the destination's `inbox/` (pipe or agent)
3. Maintains a cursor and tracking log per route

For routes that go through a pipe, the supervisor:
1. Copies from source `outbox/` → pipe instance `inbox/`
2. The pipe processes messages through its operators
3. Copies from pipe instance `outbox/` → destination `inbox/`

The pipe operators themselves run as built-in functions executed by the
supervisor, but the key insight is that the supervisor treats pipes and
agents identically for routing purposes — both are just directories with
`inbox/` and `outbox/`.

### Message identity and deduplication

Each `.msg` file has a globally unique name: `<timestamp>-<ulid>.msg`.

- `timestamp` — Unix milliseconds at message creation
- `ulid` — [ULID](https://github.com/ulid/spec) for uniqueness within the same millisecond

When the supervisor copies a message, it preserves the original filename.
The deduplication algorithm at each routing hop:

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

### Cursor-based scanning

To avoid scanning the entire outbox on every poll cycle, the supervisor
maintains a **cursor** per route — the filename of the last forwarded message.
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
On supervisor restart, the supervisor reads the last line of each tracking
file to restore its cursor position.

### Copy semantics

Messages are always **copied** (not symlinked or hard-linked):
- The source file may be deleted by GC while the destination hasn't processed
  it yet. A copy is immune.
- Symlinks break if the target moves. Hard links don't work across filesystems.
- Cost: minimal — messages are small text files.

### Built-in operators

The pipe engine ships with built-in operators. Each follows the filesystem
contract (inbox → process → outbox) so that scriptable operators can replace
or extend them in the future.

| Operator | Stateful | Description |
|---|---|---|
| **filter** | No | Pass or drop messages. jq expression evaluated per message. |
| **transform** | No | Reshape message JSON. jq expression maps input → output. |
| **split** | No | One message → N messages. jq expression returns an array; each element becomes a separate message. |
| **route** | No | Conditional fan-out. Maps jq predicates to named output channels. |
| **tap** | No | Copy every message to a side-channel directory for observability; original continues downstream. |
| **window** | Yes | Collect messages by count or time, emit as a single batch message. |
| **buffer** | Yes | Hold messages until a condition (jq predicate on the buffer contents) is met, then flush. |
| **dedupe** | Yes | Drop duplicates by a jq key expression. Maintains a seen-keys set in `state/`. |
| **throttle** | Yes | Rate-limit: forward at most N messages per T seconds. Excess messages wait in `state/pending/`. |
| **accumulate** | Yes | Fold messages into a running value. jq expression `(state, message) → new_state`. Emits the new state downstream on each input. |

#### Filter evaluation

Filters are [jq](https://stedolan.github.io/jq/) expressions evaluated against
the message JSON:

- Parse the `.msg` file as JSON
- Run `jq -e '<filter>' <file>`
- If exit code 0: forward. If non-zero or parse error: skip and log.

If the message file is not valid JSON, the filter is skipped and the message
is always forwarded (conservative default).

#### Route operator

Route enables conditional fan-out within a pipe:

```yaml
pipes:
  triage:
    through:
      - route:
          - when: '.labels | contains(["research"])'
            to: deep-researcher
          - when: '.priority == "urgent"'
            to: notify
          - otherwise: archive
```

A message can match multiple routes (all matching branches receive a copy).
`otherwise` catches messages that match no `when` clause.

The route operator creates one output channel per branch:

```
$LOOM_HOME/pipes/triage~inbox-triage→[routed]/
  operators/
    0-route/
      config.json
      inbox/
      outbox/
        deep-researcher/
        notify/
        archive/
```

### Fan-out and fan-in

**Fan-out** (one source, multiple destinations) — multiple agents or pipes
declare the same source in `from`:

```yaml
agents:
  - name: writer
    from:
      - source: researcher
  - name: archiver
    from:
      - source: researcher
```

Each destination receives its own copy.

**Fan-in** (multiple sources, one destination) — one agent lists multiple
entries in `from`:

```yaml
agents:
  - name: consolidator
    from:
      - source: researcher
      - source: analyst
```

Messages arrive interleaved by time. No ordering guarantee across sources.

### Dynamic pipes and routes via CLI

```sh
# Create a named pipe at runtime (not persisted to loom.yml)
loom pipe create urgency-gate --filter '.priority == "urgent"'

# Wire a route
loom route researcher --pipe finding-filter --to writer

# Wire direct (no pipe)
loom route editor --to writer

# Disconnect a route
loom unroute researcher --to writer

# List pipes
loom pipes

# List routes
loom routes
```

Dynamic pipes are stored in `$LOOM_HOME/pipes/` as directories. Dynamic
routes are appended to `$LOOM_HOME/routes.json`. The supervisor reloads
the routes file when it changes (detected via polling or SIGHUP).

### Origin preservation

When the supervisor copies a message between directories, it preserves the
`origin` field as-is. Neither the supervisor nor the pipe engine modifies
`origin` — that is the runner's responsibility (see ADR-009).

When a pipe applies a **transform**, the `origin` field is always preserved
from the original message, even if the jq transform does not include it.

Stateful operators that emit batch messages (window, buffer, accumulate)
set `origin` to an array of the constituent messages' origins.

### Failure reply forwarding

Failure replies flow through the same routing as any other outbox message.
Two sources of failure replies:

1. **Runner-generated** — when an agent fails to process a message, the runner
   writes a failure reply to the agent's outbox (with `error: true` and the
   correctly built `origin` path).

2. **Supervisor-generated** — when an agent hard-crashes and has exhausted its
   restart attempts, the supervisor writes failure replies to the crashed
   agent's outbox for any messages stuck in `inbox/.in-progress/`.

In both cases, the failure reply appears in the outbox like a normal message.
The supervisor routes it downstream. The receiving agent sees all expected
responses — successes and failures — and can decide how to proceed.

### Error handling

**Destination not running:** the supervisor writes to the inbox regardless.
Messages wait until the destination starts. Inbox messages are durable.

**Destination inbox does not exist:** the supervisor retries with exponential
backoff (1s, 2s, 4s, up to 30s). After 5 minutes of failures, it logs an
error and pauses the route.

**Filter evaluation failure:** logged, message skipped (recorded as `skipped`
in the pipe tracking log).

**Transform failure:** logged, original (untransformed) message forwarded
instead. A `_pipe_transform_failed: true` field is added so the recipient
can detect it. Fail-safe default.

### Stateful operator recovery

Stateful operators store their working state in the `state/` directory:

- **window/buffer**: pending messages are files in `state/pending/`.
  On restart, the operator resumes with whatever is in `pending/`.
  If `timeout` has elapsed, it flushes immediately.
- **dedupe**: seen keys stored in `state/seen.jsonl` (append-only).
  GC truncates after a configurable TTL.
- **throttle**: rate window timestamps in `state/window.json`.
- **accumulate**: current fold state in `state/current.json`.

Because state is files, recovery after a crash is automatic.

### Routing requires a supervisor

The supervisor manages all routing — both direct and through pipes. Routes
are active when agents are managed via `loom up` or `loom run --detach`
(see ADR-006).

Foreground agents (`loom run` without `--detach`) have no routing. For
one-off piping in this mode, operators can use shell tools:

```sh
loom read researcher --follow | loom send writer --stdin
```

### Pipe and route status

```sh
loom pipes

NAME              OPERATORS                      STATUS
finding-filter    filter → dedupe → window → …   active
urgency-gate      filter → throttle              active
classify          transform                      active

loom routes

SOURCE              PIPE              DEST              FORWARDED   LAST
researcher          finding-filter    writer            142         5s ago
researcher          —                 editor            89          1m ago
inbox-triage        urgency-gate      notify            31          2m ago
high-priority       —                 batch-findings    18          12m ago
```

### Cycle detection

Circular routes are detected at `loom up` time using DFS with three-colour
marking. This catches all cycles including indirect ones through pipes:

```
Error: circular route detected: researcher → classify → high-priority → researcher
```

### Future: scriptable operators

The built-in operator set is designed to be replaceable. A future extension
will allow operators to be external scripts or executables:

```yaml
pipes:
  custom-processor:
    through:
      - script: ./operators/my-custom-op.sh
        config: { threshold: 42 }
```

The contract: the script reads `.msg` files from its `inbox/`, writes `.msg`
files to its `outbox/`, and manages its own `state/`. The supervisor handles
wiring and lifecycle. This is not yet implemented.

## Consequences

### Good

**Consistent model.** Agents have directories. Pipes have directories. Both
have `inbox/`, `outbox/`, `status`. The supervisor treats them identically
for routing purposes.

**Named and reusable.** Define `urgency-gate` once, wire it into five
different connections. Each connection gets an independent instance with its
own state.

**Composable.** Pipe-to-pipe routing enables complex processing graphs built
from simple, testable building blocks. Test a pipe in isolation: drop a `.msg`
in its inbox, check its outbox.

**Observable.** `ls $LOOM_HOME/pipes/` shows all pipes. `cat .../status` shows
pipe health. Tracking logs are append-only files. `loom pipes` and `loom routes`
give live overviews. No hidden state.

**Durable.** Messages in any inbox survive supervisor restarts. Tracking logs
prevent re-delivery. Stateful operator state lives in files, enabling automatic
crash recovery.

**No message broker required.** The filesystem is the broker. Works offline.

**Supervisor stays simple.** The supervisor is a message router — it watches
directories and copies files. Pipe processing logic is separate. The routing
table is a simple JSON file.

**Extensible by design.** Built-in operators follow the same filesystem contract
(inbox/outbox/state) that future scriptable operators will use.

### Tricky

**Polling latency.** The inbox watcher uses polling (ADR-003). On Linux, inotify
could be used for sub-100ms latency. Default polling interval is 500ms —
acceptable for most agent pipelines.

**jq dependency.** Filters and transforms require `jq` installed on the host.
We bundle a jq WASM build as fallback so the runtime has no hard dependency.

**Pipe instance proliferation.** A pipe used in 10 connections creates 10
instance directories. This is correct (independent state) but may look noisy
in `ls`. Mitigation: `loom pipes` shows the logical view; the filesystem
shows the physical view.

**Tracking logs grow unboundedly.** Each forwarded message appends one line
per route hop. GC rotates these after 7 days. `loom gc` handles this.

**No ordering guarantee across fan-in.** When multiple sources feed one
destination, message order depends on file arrival time.

**Stateful operator state grows.** Dedupe seen-keys, throttle windows, and
accumulator state grow over time. Each stateful operator should define a
GC policy. `loom gc` handles this.

**Pipeline debugging.** With multiple operators, a message that doesn't arrive
could be stuck at any stage. Mitigation: `loom pipes --verbose` shows per-operator
counts and the `tap` operator can be inserted at any point for live inspection.

## Alternatives Considered

### Pipes embedded in the supervisor

The original design. The supervisor contained the pipe engine, which contained
operator logic. Rejected: conflated routing and processing, made pipes
anonymous and non-reusable, violated the "everything is a file" principle
by hiding pipe state inside the supervisor process.

### Message broker (Redis, NATS, etc.)

Persistent, high-throughput, supports pub/sub and queues. Rejected: requires
a running service, not local-first, adds operational complexity.

### Shared inbox (one inbox directory for multiple agents)

Simpler than N copies. Rejected: agents would need to coordinate reads,
adding concurrency complexity.

### Agent-to-agent direct API call

Agent A calls an HTTP endpoint on Agent B. Rejected: requires agents to be
network services, loses durability, breaks the filesystem-as-protocol principle.

### Anonymous pipes (from/to declarations)

The previous syntax declared pipes inline as `from`/`to` pairs without names.
Rejected: no reusability, no pipe-to-pipe composition, no independent pipe
lifecycle or status.

## References

- ADR-003: Inbox watcher via polling — the mechanism pipes rely on
- ADR-004: Supervisor and restart policy — the supervisor manages routing
- ADR-009: Message origin tracking — `origin` field preserved through pipes
- [ULID spec](https://github.com/ulid/spec) — sortable unique IDs for messages
- [jq manual](https://stedolan.github.io/jq/manual/) — filter/transform language

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-26 | Initial draft. |
| 2026-04-02 | **Added origin preservation.** Pipe engine copies `origin` faithfully — runner owns propagation (ADR-009). Origin is always preserved through transforms. |
| 2026-04-02 | **Added failure reply forwarding.** Pipe engine forwards runner- and supervisor-generated failure replies like any other outbox message. |
| 2026-04-02 | **Removed `in_reply_to` references.** Failure replies use `origin` path and top-level `error` field instead (ADR-009). |
| 2026-04-02 | **Added pipe operators.** Operators (filter, transform, split, route, tap, window, buffer, dedupe, throttle, accumulate) as filesystem-backed directories with inbox/outbox/state. Pipeline composition via `through` key. Built-in first, scriptable later. |
| 2026-04-03 | **Major redesign: named pipes as first-class entities.** Pipes are now named, reusable, filesystem-backed entities configured like agents. Agents declare inputs via `from`. Pipe-to-pipe routing enabled. Supervisor role narrowed to message router. Routes table introduced. Old anonymous from/to syntax replaced. |
