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
- Has a unique identifier (the PID — a short content hash)
- Has a working directory (`cwd`)
- Has environment variables (`env`)
- Has standard I/O channels (`stdin`, `stdout`, `stderr`)
- Has a status (`running`, `idle`, `waiting`, `stopped`, `exited`)
- Has a parent (the process that spawned it, or PID 1 for top-level agents)
- Has an exit code when it terminates

The `loom ps` command is exactly `ps` for agents.

Signals work as expected: SIGTERM triggers graceful shutdown, SIGKILL forces termination, SIGSTOP/SIGCONT pause and resume.

## Consequences

### Good

**Zero learning curve for the mental model.** Every developer who has used a terminal understands how processes work. There is no new abstraction to learn — only the mapping from "process" to "agent."

**Composability is solved.** Unix pipes and redirects already compose processes. We inherit this for free. `loom run --prompt extract.md < data.csv | loom run --prompt summarize.md` works exactly as expected.

**Observability is structural.** To watch what a process is doing, you `tail -f` its stdout. To see all running processes, you run `ps`. These work the same way in loom.

**Lifecycle is familiar.** Spawn, run, wait, exit. Parents can wait on children. Exit codes signal success/failure. The whole model already exists.

**Tooling integrates naturally.** `grep`, `watch`, `htop`-style tools, shell scripts, cron — all of these interact with processes in ways that transfer directly to loom agents.

### Tricky

**PIDs need content-addressing.** Unix PIDs are integers assigned by the kernel; loom PIDs are short hashes derived from the agent's identity (name + model + spawn time). This makes them stable across restarts but not strictly ordered. Commands like `loom ps --sort=pid` need to sort by time, not numeric value.

**stdin/stdout semantics change.** A Unix process reads stdin once; a loom agent may read from its inbox many times over its lifetime. We resolve this by distinguishing `loom run` (ephemeral, true stdin) from `loom spawn` (persistent, inbox-based). The model is consistent but the two modes need clear documentation.

**No kernel.** Unix processes have the kernel as a mediator — it enforces scheduling, handles signals, manages memory. loom has no equivalent. We use file locks and filesystem primitives to simulate isolation, but they are advisory, not mandatory. This is acceptable for local-first use cases.

**Process table is a directory, not kernel memory.** `loom ps` reads from `~/.loom/agents/*/meta.json`. This means a crashed agent might still appear as "running." We add a heartbeat field to `meta.json` and treat stale heartbeats (>30s) as crashed. A future GC command (`loom gc`) will clean them up.

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
