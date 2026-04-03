# ADR-001: Unix Process Model for Agents

**Status:** Accepted
**Date:** 2026-03-26
**Author:** Lorenz Hilpert

---

## Context

AI agent runtimes face a fundamental design question: what is the conceptual model for an "agent"?

Most existing systems model agents as:
- **Service instances** — long-running servers you call via API
- **Workflow nodes** — boxes in a directed graph
- **Actors** — objects with message queues (Erlang/Akka style)
- **Threads** — concurrent units within a shared process

Each of these borrows from computing history. Each brings baggage.

We need a model that:
1. Developers already understand without a manual
2. Composes naturally with existing tools
3. Makes state observable by default
4. Has well-understood lifecycle semantics
5. Scales from one agent to hundreds without architectural changes

## Decision

**Agents in loom are modeled as Unix processes.**

This is not a metaphor. It is the actual design.

A loom agent:
- Has a unique identifier (the PID — the OS process ID of the running runner)
- Has a status (`running`, `idle`, `stopped`, `pending`, `dead`, `error`, `restarting`)
- Has a parent (the supervisor that spawned it, or runs standalone in foreground mode)
- Has an exit code when it terminates

In foreground mode (`loom agent start`), an agent inherits its parent's working
directory, environment variables, and standard I/O channels — stdin is the
message input, stdout is the response output, stderr is for logs. In detached
mode (`loom agent start --detach`), these are managed by the supervisor. These
are OS-level properties of the runner process, not filesystem-stored fields.

The `loom agent ps` command is exactly `ps` for agents.

SIGTERM triggers graceful shutdown (used by `loom agent stop`), SIGKILL forces termination, and SIGHUP nudges the supervisor to re-scan agent directories. SIGSTOP/SIGCONT for pause/resume are not currently implemented.

## Consequences

### Good

**Zero learning curve for the mental model.** Every developer who has used a terminal understands how processes work. There is no new abstraction to learn — only the mapping from "process" to "agent."

**Composability is solved.** Unix pipes and redirects already compose processes. We inherit this for free. `cat data.csv | loom agent start extractor --model m --stdin | loom agent start summarizer --model m --stdin` works exactly as expected.

**Observability is structural.** To watch what a process is doing, you `tail -f` its stdout. To see all running processes, you run `ps`. These work the same way in loom.

**Lifecycle is familiar.** Spawn, run, wait, exit. Parents can wait on children. Exit codes signal success/failure. The whole model already exists.

**Tooling integrates naturally.** `grep`, `watch`, `htop`-style tools, shell scripts, cron — all of these interact with processes in ways that transfer directly to loom agents.

### Tricky

**PIDs are OS integers, not content hashes.** Unlike earlier designs that proposed content-addressed PIDs, loom uses the OS process ID of the running runner. PIDs change on every restart and are not stable identifiers — the agent *name* is the stable identifier. `loom agent ps` sorts by name, not PID.

**stdin/stdout semantics change.** A Unix process reads stdin once; a loom agent may read from its inbox many times over its lifetime. We resolve this by distinguishing `loom agent start` (foreground, true stdin/stdout/stderr) from `loom agent start --detach` (persistent, inbox-based). Foreground mode is a Unix filter; detached mode uses the filesystem inbox.

**No kernel.** Unix processes have the kernel as a mediator — it enforces scheduling, handles signals, manages memory. loom has no equivalent. We use file locks and filesystem primitives to simulate isolation, but they are advisory, not mandatory. This is acceptable for local-first use cases.

**Process table is a directory, not kernel memory.** `loom agent ps` reads from `$LOOM_HOME/agents/*/status` and other plain-text files (see ADR-002). This means a crashed agent might still appear as "running" until the supervisor detects the crash via child process exit events and updates the status file. On supervisor startup, stale PIDs are detected via `process.kill(pid, 0)` (see ADR-004). `loom gc` cleans up old crash records and processed messages (see ADR-007).

## Alternatives Considered

### Actor Model (Erlang/Akka)

Strong isolation, message-passing, supervision trees — all excellent properties. But: actors are not visible from the outside, require a running runtime to inspect, and compose poorly with Unix tools. The mental model is less universal.

### Workflow Graph (LangGraph / Temporal)

Explicit structure, replay, durability. But: workflow graphs are not good at ad hoc composition, require schema definitions up front, and the "node in a graph" model doesn't map naturally to an agent that persists over time with changing tasks.

### REST API Service

Well-understood by web developers. But: requires a server, breaks down locally, makes synchronous shell usage awkward, and adds protocol overhead for simple tasks.

### None of the Above / Novel Model

Always an option. Rejected because the Unix process model is already deeply understood, has 50 years of tooling, and handles everything we need. Novelty has a cost.

## References

- [The Art of Unix Programming](http://www.catb.org/esr/writings/taoup/) — especially chapter 1 and the philosophy of composability
- Plan 9 from Bell Labs — processes and files, taken further than Unix
- [Nix processes](https://nixos.wiki/wiki/Nix_expression_language) — content-addressed identifiers in process/package systems

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-26 | Initial decision. |
| 2026-03-31 | **Aligned with implementation.** PID changed from content hash to OS process ID (agent name is the stable identifier). Replaced `meta.json` with plain-text files per ADR-002. Updated status values, signal handling, and scoped `cwd`/`env`/`stdin`/`stdout`/`stderr` as OS-level runner properties. |
| 2026-04-03 | **CLI redesign: `loom agent start` replaces `loom run`.** Subcommand grouping (`loom agent ...`). Foreground mode is now a Unix filter (stdin/stdout/stderr). Aligns with ADR-006 redesign. |
