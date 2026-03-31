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

In foreground mode (`loom run`), an agent inherits its parent's working directory,
environment variables, and standard I/O channels. In detached mode
(`loom run --detach`), these are managed by the supervisor. These are OS-level
properties of the runner process, not filesystem-stored fields.

The `loom ps` command is exactly `ps` for agents.

SIGTERM triggers graceful shutdown (used by `loom stop`), SIGKILL forces termination, and SIGHUP nudges the supervisor to re-scan agent directories. SIGSTOP/SIGCONT for pause/resume are not currently implemented.

## Consequences

### Good

**Zero learning curve for the mental model.** Every developer who has used a terminal understands how processes work. There is no new abstraction to learn — only the mapping from "process" to "agent."

**Composability is solved.** Unix pipes and redirects already compose processes. We inherit this for free. `loom run --prompt extract.md < data.csv | loom run --prompt summarize.md` works exactly as expected.

**Observability is structural.** To watch what a process is doing, you `tail -f` its stdout. To see all running processes, you run `ps`. These work the same way in loom.

**Lifecycle is familiar.** Spawn, run, wait, exit. Parents can wait on children. Exit codes signal success/failure. The whole model already exists.

**Tooling integrates naturally.** `grep`, `watch`, `htop`-style tools, shell scripts, cron — all of these interact with processes in ways that transfer directly to loom agents.

### Tricky

**PIDs are OS integers, not content hashes.** Unlike earlier designs that proposed content-addressed PIDs, loom uses the OS process ID of the running runner. PIDs change on every restart and are not stable identifiers — the agent *name* is the stable identifier. `loom ps` sorts by name, not PID.

**stdin/stdout semantics change.** A Unix process reads stdin once; a loom agent may read from its inbox many times over its lifetime. We resolve this by distinguishing `loom run` (foreground, true stdin) from `loom run --detach` (persistent, inbox-based). The model is consistent but the two modes need clear documentation.

**No kernel.** Unix processes have the kernel as a mediator — it enforces scheduling, handles signals, manages memory. loom has no equivalent. We use file locks and filesystem primitives to simulate isolation, but they are advisory, not mandatory. This is acceptable for local-first use cases.

**Process table is a directory, not kernel memory.** `loom ps` reads from `$LOOM_HOME/agents/*/status` and other plain-text files (see ADR-002). This means a crashed agent might still appear as "running" until the supervisor detects the crash via child process exit events and updates the status file. On supervisor startup, stale PIDs are detected via `process.kill(pid, 0)` (see ADR-004). A future GC command (`loom gc`) will clean up old crash records and processed messages.

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
| 2026-03-31 | **PID definition corrected.** Changed from "short content hash" to OS process ID integer. The agent *name* is the stable identifier, not the PID. |
| 2026-03-31 | **Removed `meta.json` and heartbeat references.** The process table uses plain-text files per ADR-002, not a single `meta.json`. Stale process detection uses `process.kill(pid, 0)` per ADR-004. |
| 2026-03-31 | **Status values aligned with code.** Updated from `running | idle | waiting | stopped | exited` to `running | idle | stopped | pending | dead | error | restarting`. |
| 2026-03-31 | **Clarified `cwd`, `env`, `stdin`/`stdout`/`stderr` scope.** These are OS-level properties of the runner process, not filesystem-stored fields. |
| 2026-03-31 | **Signals updated.** SIGSTOP/SIGCONT marked as not currently implemented. Added SIGHUP for supervisor re-scan. |
| 2026-03-31 | **Replaced `loom spawn` with `loom run --detach`.** Aligns with ADR-006 which consolidated spawn into `run --detach`. |
