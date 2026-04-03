# ADR-010: Pipe runner — named, reusable message processors

**Status:** Accepted
**Date:** 2026-04-03

---

## Context

Agents need to communicate. The filesystem layout provides `inbox/` and
`outbox/` directories per agent, but something needs to move messages from
one agent's outbox to another's inbox — and optionally filter, transform,
batch, or deduplicate them along the way.

This ADR defines pipes as **named, first-class entities** — configured in
`loom.yml`, backed by the filesystem, reusable across connections.

## Decision

### Pipes are named entities

A pipe is a named message processor — an array of operators:

```yaml
pipes:
  finding-filter:
    - operator: command
      cmd: 'jq -e ".type == \"finding\""'
    - operator: dedupe
      key: '.id'
    - operator: window
      size: 5
      timeout: 30s
    - operator: command
      cmd: 'jq "{ findings: [.[].result], count: length }"'

  urgency-gate:
    - operator: command
      cmd: 'jq -e ".priority == \"urgent\""'
    - operator: throttle
      max: 10
      per: 60s
```

Names match `[a-z][a-z0-9-]*` — same rules as agents.

### Directory layout

```
$LOOM_HOME/pipes/
  finding-filter/
    config.json                           # pipe definition
  finding-filter~researcher→writer/       # instance (one per connection)
    pid
    status                                # running / idle / error / stopped
    inbox/
      .in-progress/
      .processed/
      .failed/
    steps/                                # intermediate .msg files per step
      0/                                  # output of operator 0
      1/                                  # output of operator 1
      ...
    outbox/                               # final step output
    logs/
    crashes/
    state/                                # stateful operator internal state
      dedupe/seen.jsonl
      window/pending/
      throttle/window.json
      accumulate/current.json
```

The **definition** (`finding-filter/`) holds `config.json`. The **instance**
(`finding-filter~researcher→writer/`) is a running process with its own
inbox, outbox, steps, state, and logs.

### Wiring with `from`

Every `from` entry on an agent names an `agent:` (the source). An optional
`pipe:` adds processing between source and destination:

```yaml
agents:
  - name: writer
    from:
      - agent: researcher                 # direct
        pipe: finding-filter              # through a pipe
      - agent: editor                     # direct, no pipe
```

Messages always flow **agent → (optional pipe) → agent**. No pipe-to-pipe
chaining — use multiple operators in one pipe instead. The `steps/`
directories provide intermediate observability.

### Reusability

A pipe used by multiple connections gets independent instances:

```yaml
agents:
  - name: notify
    from:
      - agent: inbox-triage
        pipe: urgency-gate
      - agent: external-monitor
        pipe: urgency-gate
```

Creates `urgency-gate~inbox-triage→notify/` and
`urgency-gate~external-monitor→notify/` — each with its own state.

Instance names: `{pipe}~{source-agent}→{dest-agent}`. The `~` and `→`
separators are reserved and not valid in names.

### Pipe instance lifecycle

Same lifecycle as agents: created at `loom up` or `loom route`, started
by supervisor, restarted on crash with backoff (ADR-004), stopped via
`loom agent stop <instance>` or `loom down`. Directories preserved after
stop. Status ownership follows ADR-005: the pipe process writes `running`
and `idle`; the supervisor writes `restarting`, `dead`, and `stopped`.

### Pipe process lifecycle

A pipe process polls `inbox/`, runs each message through its operator chain
step by step, writing intermediate results as `.msg` files:

```
1. Claim message from inbox/ → inbox/.in-progress/
2. Run operator 0 (stdin: message body)
   → Write result as .msg to steps/0/
3. Run operator 1 (stdin: steps/0/ output body)
   → Write result as .msg to steps/1/
...
N. Run operator N → Write to steps/N/ AND outbox/
N+1. Acknowledge original → inbox/.processed/
```

**Every intermediate result is a message** — full `Message` structure with
`v`, `id`, `from`, `ts`, `body`, `origin`, named `{ts}-{ulid}.msg` like
any other message file. Step files are preserved for debugging; `loom gc`
handles cleanup.

**Drop:** Command exits non-zero → no `.msg` written, chain short-circuits,
original moved to `.processed/`.

**Failure:** Unrecoverable error → failure reply to `outbox/` (with
`error: true`, correct `origin`), original to `inbox/.failed/`.

**Restart recovery:** Scan `steps/` for last completed step. Resume from
there, or move back to `inbox/` if no steps exist.

---

## Operators

Two kinds: **command** (runs any executable) and **built-in stateful**
operators (managed by the pipe process).

| Operator | Stateful | Description |
|---|---|---|
| **command** | No | stdin → stdout. Exit 0 = forward, non-zero = drop. Each stdout line = one message. |
| **tap** | Yes | Copy to `state/tap/{label}/`; original continues. |
| **window** | Yes | Collect N messages or timeout → emit batch. |
| **buffer** | Yes | Hold until jq condition met → flush. |
| **dedupe** | Yes | Drop duplicates by jq key expression. |
| **throttle** | Yes | Max N messages per T seconds. Excess held in state. |
| **accumulate** | Yes | Fold into running value. Emits new state on each input. |

### Command operator

Runs any shell command as a subprocess:

- **stdin**: message body (JSON)
- **stdout**: each line becomes a separate message body. One line = one
  message, N lines = N messages. Commands that output JSON should use
  compact format (e.g. `jq -c`) to ensure one JSON object per line.
- **exit 0**: forward
- **exit non-zero**: drop (filter)
- **stderr**: captured and logged, does not affect processing

```yaml
# Filter — jq -e exits non-zero on false/null
- operator: command
  cmd: 'jq -e ".type == \"finding\""'

# Transform
- operator: command
  cmd: 'jq "{ summary: .title, tags: .labels }"'

# Split — one JSON object per line
- operator: command
  cmd: 'jq -c ".items[]"'

# Any executable
- operator: command
  cmd: 'python3 classify.py'
```

**Error handling:** Exit non-zero = drop. Crash or timeout (default 30s) =
forward unchanged (fail-safe). Pipe process never crashes on command errors.

### Stateful operator details

**Timeouts:** Duration strings only (`30s`, `5m`, `1h`). Window and buffer
flush partial results on timeout — messages are never stuck indefinitely.
Buffer adds `_buffer_timeout: true` on timeout flush.

**Accumulate:** Reads `state/accumulate/current.json` on startup (initial
value: `null`). Persists after each message for crash safety.

**State growth:** Dedupe `seen.jsonl` and tracking logs grow unboundedly.
`loom gc` handles cleanup (see ADR-007).

**jq errors in built-ins:** Conservative defaults — accumulate forwards
current value, dedupe forwards the message, buffer adds to buffer. All
errors logged.

### Batch message format

`window`/`buffer` emit a new message at flush time:

- **`id`/`ts`** — fresh, generated at flush
- **`from`** — pipe instance name
- **`origin`** — built from the trigger message
- **`body`** — JSON-stringified array of **full constituent message objects**

`accumulate` emits the current fold value, not an array.

---

## Routing

### Supervisor as message router

The supervisor watches outbox directories and copies `.msg` files to
inbox directories per a routes table derived from `loom.yml`:

```json
[
  { "agent": "researcher", "dest": "editor" },
  { "agent": "researcher", "pipe": "finding-filter~researcher→writer", "dest": "writer" }
]
```

For piped routes, the supervisor creates two hops: agent outbox → pipe
inbox, pipe outbox → dest inbox. It treats pipe instances and agents
identically — both are directories with `inbox/` and `outbox/`.

### Deduplication

Messages have globally unique filenames: `{timestamp_ms}-{ulid}.msg`.
The supervisor preserves filenames when copying and deduplicates by checking
the destination inbox, `.processed/`, `.in-progress/`, and a tracking log.
Atomic write via `.tmp` → rename. Cursor-based scanning skips already-forwarded
messages.

### Origin preservation

Per ADR-009 — the pipe process appends the claimed message's filename to
`origin` when writing to `outbox/`. Command output always preserves the
incoming `origin`. Batch operators use the trigger message's origin.

### Fan-out and fan-in

**Fan-out:** Multiple agents declare the same source in `from`.

**Conditional fan-out:** Same source agent wired through different pipes:

```yaml
pipes:
  triage-research:
    - operator: command
      cmd: 'jq -e ".labels | contains([\"research\"])"'
  triage-urgent:
    - operator: command
      cmd: 'jq -e ".priority == \"urgent\""'

agents:
  - name: deep-researcher
    from:
      - agent: inbox-triage
        pipe: triage-research
  - name: notifier
    from:
      - agent: inbox-triage
        pipe: triage-urgent
```

**Fan-in:** One agent lists multiple `from` entries. No ordering guarantee
across sources.

### Cycle detection

DFS with three-colour marking. Checked by CLI before writing `routes.json`
and by supervisor on reload (defense-in-depth). Cycles are rejected before
activation.

### Failure reply forwarding

Failure replies (from runners or supervisor) flow through routing like
normal messages. Downstream agents see both successes and failures.

---

## Consequences

### Good

- **Consistent model.** Pipes have directories like agents — `inbox/`,
  `outbox/`, `status`. Supervisor treats both identically.
- **Observable at every level.** `ls steps/N/` shows operator output.
  `loom pipes` and `loom routes` give live overviews.
- **Reusable.** One pipe definition, multiple independent instances.
- **Extensible.** Command operator runs any executable — no loom changes
  needed for new processing logic.
- **No message broker.** The filesystem is the broker.

### Tricky

- **Polling latency.** 200ms default (ADR-003). inotify possible on Linux.
- **Instance proliferation.** 10 connections = 10 directories. `loom pipes`
  shows the logical view.
- **Unbounded state growth.** Dedupe keys, tracking logs, step files.
  `loom gc` handles cleanup (ADR-007).
- **No fan-in ordering.** Messages interleave by arrival time.

## Alternatives Considered

**Pipes embedded in supervisor:** Conflated routing and processing, hid
pipe state. Rejected.

**Message broker (Redis, NATS):** Not local-first, adds operational
complexity. Rejected.

**Pipe-to-pipe chaining:** Added routing complexity. Step directories
provide the same observability within one pipe. Rejected.

**Built-in jq operators:** Coupled loom to jq. The command operator
achieves the same with any executable. Rejected.

## References

- ADR-003: Inbox watcher — pipe processes use the same polling mechanism
- ADR-004: Supervisor — manages pipe processes identically to agents
- ADR-005: Runner — pipe process lifecycle mirrors the runner model
- ADR-009: Origin tracking — `origin` propagation applies to pipes
- [ULID spec](https://github.com/ulid/spec) — sortable unique IDs

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-26 | Initial draft. |
| 2026-04-02 | Added origin preservation, failure reply forwarding, pipe operators. |
| 2026-04-03 | Major redesign: named pipes, flat config, `from` on agents, routes table, command operator, step directories, removed pipe-to-pipe chaining. |
