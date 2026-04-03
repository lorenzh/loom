# ADR-011: loom.yml — declarative weave configuration

**Status:** Accepted
**Date:** 2026-04-03

## Context

Running a weave of agents requires coordination: which agents exist, which model each
uses, how they connect to each other, what triggers them, and what environment they
get. This configuration needs to live somewhere.

Options:
1. **Imperative CLI** — `loom spawn`, `loom pipe`, `loom route` commands
2. **Declarative file** — `loom.yml` describing the whole weave
3. **Code** — JavaScript/TypeScript API that constructs agents programmatically

Most real deployments want a file they can put in git, review in diffs, and reproduce
exactly. The imperative CLI is great for one-off commands but terrible for maintaining
a weave of 10 agents over months.

## Decision

`loom.yml` (or `loom.yaml`) is the primary way to define a weave. Running `loom up`
in a directory containing `loom.yml` starts all defined agents and pipe processes and
wires them together.

### Schema

```yaml
version: 1

# Optional: where to store agent and pipe state
# Default: ~/.loom
home: ~/.loom

# Named pipes — reusable message processors (see ADR-010)
pipes:
  finding-filter:                    # unique name, slug [a-z][a-z0-9-]*
    - operator: command
      cmd: 'jq -e ".type == \"finding\""'
    - operator: dedupe
      key: '.id'
    - operator: window
      size: 5
      timeout: 30s
    - operator: command
      cmd: 'jq "{ findings: [.[].body | fromjson | .id], count: length }"'

  urgency-gate:
    - operator: command
      cmd: 'jq -e ".priority == \"urgent\""'
    - operator: throttle
      max: 10
      per: 60s

agents:
  - name: string                    # required, unique, slug [a-z][a-z0-9-]*
    model: string                   # required, e.g. qwen3.5:9b
    system: string                  # system prompt (multiline OK via |)
    restart: always | on-failure | never    # default: always

    # Environment variables injected into the agent process
    env:
      KEY: "${ENV_VAR}"             # expand from shell environment
      KEY2: "literal-value"

    # Triggers: what wakes this agent up
    # The supervisor evaluates cron schedules and writes a .msg to the
    # agent's inbox when the schedule fires. The message body is the
    # value of `message:`. Webhooks are a future extension.
    triggers:
      - cron: "0 * * * *"          # standard 5-field cron (local TZ)
        message: "scan"            # message body sent to inbox on fire
      - webhook: "/hooks/my-agent" # HTTP POST endpoint (future)

    # Message inputs: where this agent receives messages from
    from:
      - agent: other-agent                # direct: other-agent outbox → this inbox
      - agent: researcher                 # through a pipe: researcher → pipe → this
        pipe: finding-filter

    # Memory: pre-seeded key-value pairs
    memory:
      sources: |
        https://news.ycombinator.com
        https://lobste.rs
```

### Pipe operators

Each entry in a pipe's operator array is a single operator. Operators run in
sequence within the pipe process — a message passes through each in order.

#### Command operator

The `command` operator replaces the old `filter`, `transform`, and `split`
operators with a single shell-command primitive:

- **stdin**: message body (JSON)
- **stdout**: output. Each line = one message. Single line = one message, N lines = N messages.
- **exit 0**: forward output
- **exit non-zero**: drop message (filter behavior)

Any executable works — not just jq.

```yaml
# Filter — exit non-zero drops the message
- operator: command
  cmd: 'jq -e ".type == \"finding\""'

# Transform — reshape message body
- operator: command
  cmd: 'jq "{ summary: .title, score: .relevance }"'

# Split — each stdout line becomes a separate message
- operator: command
  cmd: 'jq -c ".items[]"'

# Any language works
- operator: command
  cmd: 'python3 ./scripts/classify.py'
```

#### Stateful operators

Stateful operators persist working state under the pipe instance's `state/`
directory. All state survives restarts automatically.

```yaml
# tap — copy every message to a side-channel for inspection; original continues.
# Messages accumulate in state/tap/{label}/ as plain .msg files.
- operator: tap
  label: before-window

# window — collect N messages or wait for timeout, emit one batch message.
# Batch body is a JSON array of full constituent message objects.
- operator: window
  size: 5
  timeout: 30s

# buffer — hold messages until a jq condition on the buffer is met, then flush.
# timeout is a safety valve in case the condition is never met.
- operator: buffer
  until: 'length >= 3 and all(.[]; .status == "done")'
  timeout: 5m

# dedupe — drop duplicate messages by a jq key expression.
- operator: dedupe
  key: '.id'

# throttle — forward at most N messages per time window.
# Excess messages are held in state/throttle/ and forwarded when the window resets.
- operator: throttle
  max: 10
  per: 60s

# accumulate — fold messages into a running value.
# jq expression receives [current_state, message] and returns new_state.
# Emits the new state as the body on every input. Initial state is null.
- operator: accumulate
  expr: '.[0] as $state | .[1] as $msg | ($state // []) + [$msg.body | fromjson]'
```

#### Duration format

All timeout and rate-limit values use duration strings: `30s`, `5m`, `1h`.
Integer milliseconds are not accepted.

### Wiring patterns

Two patterns, one `from` syntax. Every entry names an `agent:`. An optional
`pipe:` adds processing between source and destination.

```yaml
# Direct: agent → agent (no pipe)
from:
  - agent: researcher

# Through a pipe: agent → pipe → agent
from:
  - agent: researcher
    pipe: finding-filter
```

There is no pipe-to-pipe chaining. Use multiple operators within a single
pipe instead — the `steps/` directories provide the same intermediate
observability (see ADR-010).

```yaml
# Instead of chaining classify → high-priority (2 pipes), combine them:
pipes:
  classify-and-filter:
    - operator: command
      cmd: 'jq ". + { category: (if .score > 0.8 then \"high\" else \"low\" end) }"'
    - operator: command
      cmd: 'jq -e ".category == \"high\""'

agents:
  - name: analyst
    from:
      - agent: researcher
        pipe: classify-and-filter
```

### Conditional fan-out

Conditional fan-out is achieved by wiring the same source agent through
different pipes. Each pipe independently passes or drops messages:

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

A message matching both conditions reaches both agents. Mutually exclusive
branches require the caller to use negation in filter expressions.

### Reusability

Named pipes are reusable across multiple connections. Each connection gets its
own pipe process instance with independent state:

```yaml
pipes:
  urgency-gate:
    - operator: command
      cmd: 'jq -e ".priority == \"urgent\""'
    - operator: throttle
      max: 10
      per: 60s

agents:
  - name: notify
    from:
      - agent: inbox-triage
        pipe: urgency-gate
      - agent: external-monitor
        pipe: urgency-gate
```

This creates two pipe process instances:
- `urgency-gate~inbox-triage→notify`
- `urgency-gate~external-monitor→notify`

Each has its own inbox, outbox, state, and crash history.

### Validation rules

- `name` must be unique within the weave
- `name` must match `[a-z][a-z0-9-]*` (no spaces, no uppercase)
- Agent names and pipe names share the same namespace — a pipe cannot have
  the same name as an agent
- `model` must be non-empty; validation against available providers is done at
  spawn time, not parse time (providers may be offline during parse)
- `from` entries: `agent:` must reference an existing agent, `pipe:` must
  reference an existing pipe; unknown names are rejected at parse time
- Circular routes are detected at `loom up` time. Since messages always flow
  agent → (optional pipe) → agent, cycles can only occur between agents:
  ```
  Error: circular route detected: researcher → writer → researcher
  ```
- `loom route` (dynamic) also runs cycle detection before writing to
  `routes.json` — a cycle is rejected before anything is written

### Resolution order

`loom up` looks for config in this order:
1. `--config <path>` flag
2. `./loom.yml`
3. `./loom.yaml`
4. `$LOOM_HOME/loom.yml`

### `loom up` semantics

`loom up` is idempotent:
- Agents and pipe processes already running with the same config are left untouched
- Agents or pipes with changed config are restarted
- Agents or pipes removed from `loom.yml` are stopped
- New agents and pipes are started

Change detection uses a content hash of the config block, stored in
`agents/{name}/config.hash` and `pipes/{name}/config.hash`. If the hash
matches, no restart.

### `loom down`

Stops all agents and pipe processes defined in `loom.yml`. Does not delete
their state directories — inbox messages, operator state, memory, and logs
are preserved.

### Multi-environment config

```yaml
agents:
  - name: researcher
    model: "${LOOM_MODEL:-qwen3.5:9b}"   # override via env var, fallback to default
```

No built-in concept of "environments" — that is shell's job.

## Consequences

**Good:**
- Weave config is a single file, version-controlled, reviewable as a diff
- `loom up` is idempotent — safe to run repeatedly in CI or on boot
- Shell variable expansion keeps secrets out of the config file
- Pipes are named, reusable, and independently observable processes
- Conditional fan-out composes from primitives (multiple pipes + filter) — no
  special operator syntax needed
- Routes and triggers are declared, not wired imperatively — easier to audit
- Duration strings (`30s`, `5m`) are human-readable and unambiguous

**Bad:**
- Dynamic weaves (agents that spawn other agents at runtime) can't be fully
  expressed in a static YAML file. Runtime spawning is an advanced case
  handled via the plugin API (ADR-006), not the config file.
- YAML has footguns (implicit type coercion, indentation errors). A JSON schema
  lives at `schemas/loom.yml.json`. Add this to get editor auto-complete:
  ```yaml
  # yaml-language-server: $schema=https://raw.githubusercontent.com/lorenzh/loom/main/schemas/loom.yml.json
  ```
- Command operators on batch messages require unwrapping inner bodies:
  `jq '[.[].body | fromjson | .field]'` instead of `jq '[.[].field]'`.

## Alternatives considered

**TOML:** More explicit than YAML, no implicit coercion. Considered but YAML is more
familiar for this audience and supports multiline strings cleanly (critical for system
prompts). Rejected.

**JSON:** Too verbose for system prompts. Rejected.

**TypeScript config (like Vite):** Maximum flexibility. But requires a bundler/runtime
to evaluate. Makes config opaque to non-JS tools. Rejected for v1; may be added as
`loom.config.ts` in a future release for programmatic weave construction.

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-25 | Initial draft. |
| 2026-04-03 | **Complete redesign: named pipes, `from` wiring, command operators.** Pipes are top-level named entities with reusable operator chains. Agents declare inputs via `from` with `agent:` (direct) or `agent:` + `pipe:` (through a pipe). No pipe-to-pipe chaining. Stateless operators unified as `operator: command` (shell commands). Full stateful operator catalog: window, buffer, dedupe, throttle, accumulate, tap. Duration strings (`30s`, `5m`). Shared agent/pipe namespace. Cycle detection at `loom up` time. |
