# ADR-006: CLI and agent lifecycle

**Status:** Accepted
**Date:** 2026-03-30

---

## Context

loom needs a CLI that covers the full agent lifecycle: starting, stopping,
inspecting, and managing agents. The CLI design determines how operators
interact with loom day-to-day.

The primary tension is between:
- **Simplicity** — a small set of commands that cover common cases
- **Power** — enough flexibility for multi-agent weaves, scripting, and automation
- **Familiarity** — operators should not need to learn a new mental model

Docker solved this well: `docker run` for single containers, `docker compose up`
for multi-container stacks. The two modes share the same underlying runtime but
serve different use cases. loom adopts the same pattern.

## Decision

### Two primary commands

**`loom run`** — start a single agent.

```sh
# Foreground (interactive, streams output to terminal)
loom run --name researcher --model qwen3.5:9b

# Foreground with initial message
loom run --name researcher --model qwen3.5:9b --prompt "Research Unix history"

# Pipe input as first message
echo "summarize this" | loom run --name researcher --model qwen3.5:9b

# Background (detached, supervised)
loom run --name researcher --model qwen3.5:9b --detach
```

In all cases, `loom run` creates `$LOOM_HOME/agents/{name}/` if it doesn't
exist. The runner polls the inbox, processes messages, and writes responses
to the outbox.

**`loom up`** — start a weave of agents from `loom.yml`.

```sh
loom up                    # reads ./loom.yml
loom up --config prod.yml  # explicit config file
loom up -d                 # detached
```

`loom up` starts the supervisor, which spawns a runner for each agent defined
in `loom.yml` and wires the pipe engine for inter-agent communication.

### Foreground vs detached

| Mode | Supervisor? | Restart on crash? | Pipe engine? |
|---|---|---|---|
| `loom run` (foreground) | No | No | No |
| `loom run --detach` | Yes | Yes | Yes |
| `loom up` | Yes | Yes | Yes |

The pipe engine runs inside the supervisor. Since `--detach` starts (or reuses)
a supervisor, pipes are available for detached agents. Multiple detached agents
sharing the same supervisor can pipe to each other.

### Detach starts a supervisor on-demand

When `loom run --detach` is used:

1. CLI creates `$LOOM_HOME/agents/{name}/` directory and writes config files
2. CLI writes `status: pending`
3. CLI checks if a supervisor is already running (`$LOOM_HOME/supervisor.pid`)
4. If no supervisor → start one
5. CLI sends `SIGHUP` to supervisor → "re-scan agent directories"
6. Supervisor detects new agent, spawns the runner
7. CLI exits. Agent keeps running under supervision.

The CLI communicates with the supervisor via the **filesystem + SIGHUP** pattern
(see ADR-004). The filesystem is the source of truth; the signal is a nudge to
act immediately rather than waiting for the next periodic scan.

The on-demand supervisor exits when its last managed agent stops. No orphan
daemon lingers on the developer's machine.

If the supervisor is managed by systemd, it runs persistently and does not
auto-exit. On system reboot, systemd restarts the supervisor, which reads
agent state and restarts agents that weren't explicitly stopped (see ADR-004).

### Supporting commands

```sh
loom ps                  # list running agents (reads filesystem)
loom stop <name>         # stop a specific agent (writes status: stopped)
loom logs <name>         # view agent logs (tail -f logs/*.ndjson)
loom down                # stop all agents started by loom up
loom send <name> <msg>   # send a message to an agent's inbox
```

**`loom ps`** reads `$LOOM_HOME/agents/*/status` directly — it works even
if no supervisor or agent is running. Example output:

```
NAME            STATUS      MODEL           RESTARTS  UPTIME
researcher      running     qwen3.5:9b      0         5m
writer          idle        qwen3.5:9b      0         5m
news-monitor    dead        qwen2.5:3b      11        —
```

**`loom stop`** writes `status: stopped` to the agent's status file, then sends
SIGTERM to the runner process. The supervisor respects `stopped` status and
will not restart the agent (see ADR-004).

**`loom down`** stops all agents defined in the current `loom.yml` and the
supervisor. Agent state directories are preserved — inbox messages, memory,
and logs remain on disk.

### No separate `loom spawn`

Earlier designs had three commands: `run` (ephemeral), `spawn` (persistent),
and `up` (weave). This was simplified to two:

- `loom run` covers both interactive and persistent single-agent use
  (foreground vs `--detach`)
- `loom up` covers multi-agent weaves

The `spawn` concept is subsumed by `loom run --detach`.

## Consequences

### Good

**Familiar mental model.** Operators who know Docker already know how loom
works: `run` for one, `up` for many, `ps` to inspect, `stop` to halt.

**Graceful complexity gradient.** Start with `loom run` for quick experiments.
Move to `loom run --detach` for persistent agents. Graduate to `loom up` for
full weaves. Same agent code at every level.

**Supervisor is invisible by default.** Developers don't need to know about
the supervisor to use `loom run`. It becomes visible only when they need
crash recovery (`--detach`) or multi-agent orchestration (`loom up`).

### Tricky

**On-demand supervisor lifecycle.** Starting and stopping the supervisor
transparently requires careful PID file management. If the supervisor
crashes between agent spawns, the CLI must detect the stale PID file and
start a new supervisor.

**`loom run` without `--detach` has no restart protection.** If the agent
crashes, it stays dead. This is intentional — foreground mode is for
development and scripting, not production. The operator sees the crash
immediately in their terminal.

**No pipe engine in foreground mode.** A foreground `loom run` agent (no
`--detach`) has no supervisor and therefore no pipe engine. It cannot
receive piped messages from other agents' outboxes. For one-off piping
in foreground mode, operators can use shell tools:
`loom read researcher --follow | loom send writer --stdin`.

## Alternatives considered

**Three commands (run / spawn / up):**
`spawn` as a separate command for persistent agents. Rejected — `--detach`
on `run` is simpler and mirrors Docker's approach. One less command to learn.

**Always require a supervisor:**
Even foreground agents run under the supervisor. Rejected — adds complexity
for the simplest use case (quick one-off agent). The supervisor should be
opt-in, not mandatory.

**No CLI, just a library:**
Expose only a TypeScript API, let operators write their own scripts. Rejected —
the CLI is the primary interface for the Unix process model. `loom ps` must
be a command, not a function call.

## References

- Docker CLI: `docker run`, `docker compose up` — the model we follow
- ADR-004: Supervisor and restart policy — lifecycle management
- ADR-005: Runner architecture — what runs inside an agent process
- loom.yml ADR (draft): Declarative weave configuration for `loom up`

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-31 | **Audited against codebase.** No design contradictions found. All commands are forward-looking design specifications. |
