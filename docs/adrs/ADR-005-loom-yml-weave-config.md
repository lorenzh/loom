# ADR-005: loom.yml — declarative weave configuration

**Status:** Draft
**Date:** 2026-03-25

## Context

Running a weave of agents requires coordination: which agents exist, which model each
uses, how they connect to each other, what triggers them, and what environment they
get. This configuration needs to live somewhere.

Options:
1. **Imperative CLI** — `loom spawn`, `loom pipe`, `loom set-trigger` commands
2. **Declarative file** — `loom.yml` describing the whole weave
3. **Code** — JavaScript/TypeScript API that constructs agents programmatically

Most real deployments want a file they can put in git, review in diffs, and reproduce
exactly. The imperative CLI is great for one-off commands but terrible for maintaining
a weave of 10 agents over months.

## Decision

`loom.yml` (or `loom.yaml`) is the primary way to define a weave. Running `loom up`
in a directory containing `loom.yml` starts all defined agents and wires them together.

### Schema

```yaml
version: 1

# Optional: where to store agent state
# Default: ~/.loom
home: ~/.loom

agents:
  - name: string                    # required, unique, slug (a-z0-9-)
    model: string                   # required, see model routing ADR
    system: string                  # system prompt (multiline OK via |)
    restart: always | on-failure | never    # default: always

    # Environment variables injected into the agent process
    env:
      KEY: "${ENV_VAR}"             # expand from shell environment
      KEY2: "literal-value"

    # Triggers: what wakes this agent up
    triggers:
      - cron: "0 * * * *"          # standard 5-field cron (local TZ)
        message: "scan"            # message body to send when trigger fires
      - webhook: "/hooks/my-agent" # HTTP POST endpoint (future)

    # Pipes: automatically forward messages from another agent's outbox
    pipes:
      - from: other-agent          # pipe other-agent's outbox → this inbox
        filter: "[URGENT]"         # optional: only forward if body contains

    # Memory: pre-seeded key-value pairs
    memory:
      sources: |
        https://news.ycombinator.com
        https://lobste.rs
```

### Validation rules

- `name` must be unique within the weave
- `name` must match `[a-z][a-z0-9-]*` (no spaces, no uppercase)
- `model` must be non-empty; validation against available providers is done at spawn
  time, not at parse time (providers may be offline during parse)
- Circular pipes are detected at `loom up` time using *DFS with three-colour marking*
  (unvisited → in-progress → done). This catches all cycles including indirect ones
  (A→B→C→A). The full cycle path is reported in the error:
  ```
  Error: circular pipe detected: news-monitor → inbox-triage → deep-researcher → news-monitor
  ```
  Implementation: `packages/runtime/src/pipe-validator.ts` — `detectCycles(agents)`
- `filter` is a substring match (not regex) for v1. Regex support in a later release.

### Resolution order

`loom up` looks for config in this order:
1. `--config <path>` flag
2. `./loom.yml`
3. `./loom.yaml`
4. `$LOOM_HOME/loom.yml`

### `loom up` semantics

`loom up` is idempotent:
- Agents already running with the same config are left untouched
- Agents with changed config (different model, system prompt) are restarted
- Agents removed from `loom.yml` are stopped (`restart: never` semantics applied)
- New agents are started

Change detection uses a content hash of the agent's config block, stored in
`agents/{name}/config.hash`. If the hash matches, no restart.

### `loom down`

Stops all agents defined in `loom.yml`. Does not delete their state directories —
inbox messages, memory, and logs are preserved.

### Multi-environment config

For environment-specific config, use shell variable expansion:

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
- Pipes and triggers are declared, not wired imperatively — easier to audit

**Bad:**
- Dynamic weaves (agents that spawn other agents at runtime) can't be fully expressed
  in a static YAML file. This is intentional — runtime spawning is an advanced case
  handled via the plugin API (ADR-006), not the config file.
- YAML has footguns (implicit type coercion, indentation errors). A JSON schema lives at `schemas/loom.yml.json`, published at:
  `https://raw.githubusercontent.com/lorenzh/loom/main/schemas/loom.yml.json`

  Add this line to the top of your `loom.yml` for editor auto-complete and validation:
  ```yaml
  # yaml-language-server: $schema=https://raw.githubusercontent.com/lorenzh/loom/main/schemas/loom.yml.json
  ```

  A future `loom validate` command will lint config files before deployment.

## Alternatives considered

**TOML:** More explicit than YAML, no implicit coercion. Considered but YAML is more
familiar for this audience and supports multiline strings cleanly (critical for system
prompts). Rejected.

**JSON:** Too verbose for system prompts. Rejected.

**TypeScript config (like Vite):** Maximum flexibility. But requires a bundler/runtime
to evaluate. Makes config opaque to non-JS tools. Rejected for v1; may be added as
`loom.config.ts` in a future release for programmatic weave construction.