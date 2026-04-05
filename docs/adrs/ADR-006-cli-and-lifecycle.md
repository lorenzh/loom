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
for multi-container stacks. loom adopts a similar two-tier pattern but uses
subcommand grouping (`loom agent ...`) to separate agent operations from weave
orchestration, and makes foreground agents proper Unix filters.

## Decision

### Command structure

Commands are grouped by resource:

- **`loom agent ...`** — single-agent lifecycle (start, stop, ps, send, logs)
- **`loom up` / `loom down`** — weave orchestration from `loom.yml`
- **`loom pipe ...`** / **`loom route ...`** — dynamic pipe and route management

### `loom agent start` — start a single agent

```sh
# Foreground (interactive, stdin/stdout/stderr)
loom agent start my-agent --model qwen3.5:9b

# Background (supervised, restarts on crash)
loom agent start my-agent --model qwen3.5:9b --detach
```

In all cases, `loom agent start` creates `$LOOM_HOME/agents/{name}/` if it
doesn't exist. The runner polls the inbox, processes messages, and writes
responses to the outbox.

### Foreground mode — agents as Unix filters

In foreground mode the agent operates via **stdin, stdout, and stderr**:

- **stdin** — input is wrapped in a message and sent to the agent's inbox
- **stdout** — the LLM response body is written here
- **stderr** — logs, status updates, and errors

This makes agents composable with standard Unix tools:

```sh
# Pipe a prompt through a model
echo "extract action items" | loom agent start my-agent --model qwen3:8b --stdin

# Chain models together
cat report.md | loom agent start summarizer --model qwen3:8b --stdin \
  | loom agent start prioritizer --model qwen3:32b --stdin --system "prioritize by urgency"

# Filter output with standard tools
loom agent start extractor --model qwen3:8b --stdin < prompt.txt | grep "TODO" | tee results.txt
```

The `--stdin` flag reads the message body from stdin. Without `--stdin`,
the agent starts interactively.

In `--stdin` mode the runner processes only the message that was piped in —
it skips crash recovery and ignores any pre-existing inbox messages. This
guarantees that the stdout output corresponds exactly to the stdin input,
making agents reliable components in shell pipelines.

### `loom up` — start a weave from `loom.yml`

```sh
loom up                    # reads ./loom.yml
loom up --config prod.yml  # explicit config file
loom up -d                 # detached
```

`loom up` starts the supervisor, which spawns a runner for each agent defined
in `loom.yml` and wires message routing for inter-agent communication.

### Foreground vs detached

| Mode | Supervisor? | Restart on crash? | Message routing? | I/O |
|---|---|---|---|---|
| `loom agent start` (foreground) | No | No | No | stdin/stdout/stderr |
| `loom agent start --detach` | Yes | Yes | Yes | Filesystem only |
| `loom up` | Yes | Yes | Yes | Filesystem only |

The supervisor handles message routing — moving messages between agent outboxes,
pipe inboxes/outboxes, and agent inboxes (see ADR-010). Since `--detach`
starts (or reuses) a supervisor, pipes and routes are available for detached
agents. Multiple detached agents sharing the same supervisor can route messages
to each other.

### Detach starts a supervisor on-demand

When `loom agent start --detach` is used:

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

### Supporting agent commands

```sh
loom agent ps                  # list running agents (reads filesystem)
loom agent stop <name>         # stop a specific agent or pipe instance
loom agent logs <name>         # view agent logs (tail -f logs/*.ndjson)
loom agent send <name> <msg>   # send a message to an agent's inbox
```

**`loom agent ps`** reads `$LOOM_HOME/agents/*/status` directly — it works
even if no supervisor or agent is running. Example output:

```
NAME            STATUS      MODEL           RESTARTS  UPTIME
researcher      running     qwen3.5:9b      0         5m
writer          idle        qwen3.5:9b      0         5m
news-monitor    dead        qwen2.5:3b      11        —
```

**`loom agent stop`** writes `status: stopped` to the agent's or pipe
instance's status file, then sends SIGTERM to the process. The supervisor
respects `stopped` status and will not restart it (see ADR-004). Works for
both agents and pipe instances (e.g.
`loom agent stop finding-filter~researcher→writer`).

**`loom down`** stops all agents and pipe instances defined in the current
`loom.yml` and the supervisor. State directories are preserved — inbox
messages, memory, and logs remain on disk.

### Pipe and route management commands

```sh
loom pipe create <name> --filter '<expr>'  # create a named pipe at runtime
loom route <source> --to <dest>            # wire a direct route
loom route <source> --pipe <name> --to <dest>  # wire a route through a pipe
loom unroute <source> --to <dest>          # disconnect a route
loom pipes                                 # list pipe definitions and instances
loom routes                                # list active routes with stats
```

Dynamic pipes and routes are stored in `$LOOM_HOME/pipes/` and
`$LOOM_HOME/routes.json` respectively. The supervisor reloads the routes
file on change (see ADR-010).

Both `loom route` and `loom up` validate for circular routes before writing
to `routes.json`. If a cycle would be created, the command fails immediately.

## Consequences

### Good

**Unix filter composability.** Foreground agents read stdin and write stdout,
so they compose with shell pipes, `grep`, `tee`, `jq`, and every other Unix
tool. Chaining two agents is just `| loom agent start ... --stdin |`.

**Graceful complexity gradient.** Start with `loom agent start` for quick
experiments. Move to `--detach` for persistent agents. Graduate to `loom up`
for full weaves. Same agent code at every level.

**Supervisor is invisible by default.** Developers don't need to know about
the supervisor to use `loom agent start`. It becomes visible only when they
need crash recovery (`--detach`) or multi-agent orchestration (`loom up`).

### Tricky

**On-demand supervisor lifecycle.** Starting and stopping the supervisor
transparently requires careful PID file management. If the supervisor
crashes between agent spawns, the CLI must detect the stale PID file and
start a new supervisor.

**Foreground mode has no restart protection.** If the agent crashes, it stays
dead. This is intentional — foreground mode is for development and scripting,
not production. The operator sees the crash immediately in their terminal.

**No message routing in foreground mode.** A foreground agent (no `--detach`)
has no supervisor and therefore no message routing. It cannot receive routed
messages from other agents' outboxes or through pipes. For one-off piping
in foreground mode, operators compose via shell pipes:
`cat input.txt | loom agent start a --model m --stdin | loom agent start b --model m --stdin`.

## Alternatives considered

**Flat commands (`loom run`, `loom ps`):**
Earlier designs used top-level commands without resource grouping. Rejected —
`loom agent start` is more discoverable and leaves room for `loom pipe ...`,
`loom route ...` without polluting the top-level namespace.

**Three commands (run / spawn / up):**
`spawn` as a separate command for persistent agents. Rejected — `--detach`
on `agent start` is simpler. One less command to learn.

**Always require a supervisor:**
Even foreground agents run under the supervisor. Rejected — adds complexity
for the simplest use case (quick one-off agent). The supervisor should be
opt-in, not mandatory.

**No CLI, just a library:**
Expose only a TypeScript API, let operators write their own scripts. Rejected —
the CLI is the primary interface for the Unix process model. `loom agent ps`
must be a command, not a function call.

## References

- Docker CLI: `docker run`, `docker compose up` — the model we follow
- ADR-004: Supervisor and restart policy — lifecycle management
- ADR-005: Runner architecture — what runs inside an agent process
- ADR-011: loom.yml — declarative weave configuration for `loom up`

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-30 | Initial decision. |
| 2026-04-03 | **CLI redesign: subcommand grouping, Unix filter mode, pipe/route commands.** Replaced `loom run` with `loom agent start`, `loom ps` with `loom agent ps`. Foreground agents are Unix filters (stdin/stdout/stderr, `--stdin` flag). Added `loom pipe create`, `loom route`, `loom unroute`, `loom pipes`, `loom routes`. Updated `loom stop` and `loom down` to cover pipe instances. |
| 2026-04-05 | **Stdin mode scoped to piped message only.** `--stdin` now targets only the message created from stdin input, skipping crash recovery and pre-existing inbox contents for deterministic pipeline behavior. |
