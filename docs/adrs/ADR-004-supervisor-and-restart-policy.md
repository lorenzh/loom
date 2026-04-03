# ADR-004: Supervisor and restart policy

**Status:** Accepted
**Date:** 2026-03-25

## Context

Agents crash. The model call times out. The process OOMs. A plugin throws an unhandled
exception. The machine reboots. Whatever the cause, the system needs to recover without
human intervention at 3am.

Unix daemons have solved this with supervisors: a parent process that watches children
and restarts them on failure. `systemd`, `supervisord`, `pm2`, `s6` all implement
variations of the same idea.

loom needs a supervisor that:
1. Detects when an agent process has died
2. Restarts it with appropriate backoff
3. Surfaces the failure visibly (in the filesystem, not just stderr)
4. Respects the operator's intent — some agents should restart, others should not

## Decision

### Supervisor process

The supervisor is a **process manager and message router** — it spawns runners,
detects crashes, restarts with backoff, and routes messages between agents and
pipes. It does NOT mediate message processing; runners are self-sufficient
(see ADR-005), and pipes are independent filesystem-backed entities
(see ADR-010).

As a **message router**, the supervisor watches outbox directories (of both
agents and pipes) and copies new `.msg` files to the appropriate inbox
directories according to a routes table derived from `loom.yml`. Pipes are
named, reusable entities with their own directories — the supervisor moves
files into and out of them but does not contain pipe logic.

The supervisor is itself an OS process with a PID written to `$LOOM_HOME/supervisor.pid`.
If the supervisor dies, runners continue running — they keep polling their inboxes and
processing messages. They just lose restart protection and message routing.

### Supervisor lifecycle

The supervisor operates in one of two modes:

**Systemd-managed (server/homelab):** Registered as a systemd service, runs
persistently. On system reboot, systemd starts the supervisor, which reads agent
state from the filesystem and restarts agents that weren't explicitly stopped.

**On-demand (developer machine):** Started automatically by the first
`loom agent start --detach` command. Exits when the last managed agent stops.
No orphan daemon lingers on the developer's machine.

### How the supervisor spawns agents

The supervisor spawns each agent as a separate OS process via `Bun.spawn()`.
Each runner is a child of the supervisor and manages its own inbox, outbox,
logs, and status files (see ADR-005).

### Health check

The supervisor detects agent crashes via child process exit events — when
`Bun.spawn()` creates a child, the supervisor receives an exit event when
that child dies. No polling is required for agents spawned by the supervisor.

On startup (or restart), the supervisor re-adopts agents that were already
running by reading their PID files and verifying the processes are alive
via `process.kill(pid, 0)`.

### Restart policy

Each agent has a restart policy, configurable in `loom.yml`:

```yaml
agents:
  - name: my-agent
    restart: always       # always restart (default)
    # restart: on-failure # only restart on non-zero exit
    # restart: never      # do not restart
```

When `restart: always` or `restart: on-failure` (and the agent exited non-zero):

1. Write `status: restarting` to `agents/{name}/status`
2. Write a crash record to `agents/{name}/crashes/`:
   ```
   agents/{name}/crashes/
     {timestamp_ns}-{ulid}.json   ← crash record
   ```
   Crash record format:
   ```json
   {
     "ts": "2026-03-25T05:00:00.000Z",
     "exitCode": 1,
     "signal": null,
     "restartCount": 3,
     "nextRestartAt": "2026-03-25T05:00:16.000Z"
   }
   ```
3. Wait for the backoff delay
4. Spawn a new agent process
5. Write new PID to `agents/{name}/pid`
6. Write `status: running`

### Backoff

Exponential backoff with jitter, capped at `maxBackoffMs`:

```
delay = min(baseDelayMs * 2^restartCount, maxBackoffMs) + jitter(0..500ms)
```

Defaults:
- `baseDelayMs`: 1000 (1 second)
- `maxBackoffMs`: 300000 (5 minutes)
- `maxRestarts`: 10 (then write `status: dead` and stop trying)

After `maxRestarts` failures within a `resetWindowMs` (default 3600000ms = 1 hour),
the agent is considered permanently failed and the supervisor stops restarting it.

When an agent is declared dead (maxRestarts exhausted), the supervisor also writes
**failure replies** to the agent's `outbox/` for any messages still in
`inbox/.in-progress/`. Each failure reply builds the `origin` path from the
orphaned message, with `error: true`. The pipe runner forwards these downstream
so fan-in aggregators are not left waiting indefinitely (see ADR-009).

An operator can resume the agent by writing `status: pending` and sending SIGHUP
to the supervisor, or by running `loom agent stop {name}` followed by
`loom agent start {name} --detach`.

### Visibility

Crashes are always written to the filesystem — never silently swallowed:

```
agents/my-agent/
  status           ← "dead" or "restarting"
  crashes/
    1742900000-01HX.json   ← each crash is a file
```

`loom agent ps` shows restart count in the status column:
```
NAME            STATUS      MODEL           RESTARTS  UPTIME
my-agent        running     qwen3.5:9b      3         2m
news-monitor    dead        qwen2.5:3b      11        —
```

### CLI-to-supervisor communication

The filesystem is the source of truth for all communication between the CLI
and the supervisor. The CLI writes state to the filesystem; the supervisor
reads it. A `SIGHUP` signal nudges the supervisor to re-scan immediately.

This follows the pattern used by many Unix daemons (`nginx -s reload`,
`sshd` config reload): the filesystem holds the config, the signal says
"look now."

**Starting a new agent (`loom agent start --detach`):**

```
1. CLI creates agents/{name}/ directory + config files (model, prompt, etc.)
2. CLI writes status: pending
3. CLI starts supervisor if not running (checks supervisor.pid)
4. CLI sends SIGHUP to supervisor PID → "re-scan agent dirs"
5. Supervisor detects new agent with status: pending
6. Supervisor spawns runner
7. Runner writes status: running
```

If the SIGHUP is missed (supervisor not yet ready, signal lost), the
supervisor picks up the new agent on its next periodic scan. The signal
is an optimization, not a requirement.

**Stopping an agent (`loom agent stop`):**

```
1. CLI writes status: stopped to agents/{name}/status
2. CLI sends SIGTERM to runner PID (from agents/{name}/pid)
3. Runner receives SIGTERM, shuts down gracefully, exits
4. Supervisor sees child exit, reads status: stopped → does not restart
```

The supervisor does not need a signal here — it learns about the stop via
the child exit event and the `stopped` status file.

**Supervisor periodic scan:**

As a fallback, the supervisor periodically scans `$LOOM_HOME/agents/*/status`
(default every 5 seconds) to detect changes it may have missed. This ensures
eventual consistency even if signals are lost.

### Startup behaviour

On startup, the supervisor reads `$LOOM_HOME/agents/*/status` to determine which
agents to (re)start:

- `stopped` → **leave stopped** — user explicitly stopped this agent, do not touch
- Any other status (`running`, `idle`, `error`, `dead`, `restarting`) →
  **restart if the agent's restart policy allows it**

The restart counter resets on supervisor startup. This means `dead` agents (those
that hit `maxRestarts` in a previous supervisor session) get a fresh chance after
a system reboot or supervisor restart.

The supervisor does not install itself as a system service. That is the operator's job.
A systemd unit file template will be provided in `docs/examples/loom-supervisor.service`.

## Consequences

**Good:**
- Crash recovery is automatic and visible — crash files are in the filesystem
- Operators can inspect exactly when and why each crash happened
- Backoff prevents runaway restart loops from hammering the GPU
- `restart: never` supports one-shot or batch agents that should not loop

**Bad:**
- The supervisor is itself a single point of failure. If it dies, agents keep running
  but lose restart protection and message routing. Mitigated by running the supervisor
  under systemd (which will restart it).
- Crash files accumulate. `loom gc` compacts old crash records (see ADR-007).

## Alternatives considered

**Using OS-level process supervision (systemd/launchd directly):**
Possible but requires root and system configuration. loom targets developer machines
and homelab servers where operators may not have root, and where one binary should
"just work". Rejected for the default path; supported as an optional deployment mode.

**PID polling instead of child exit events:**
The supervisor could poll agent PIDs periodically instead of relying on child exit
events. This would decouple agent lifetime from supervisor lifetime but adds detection
latency (up to 5 seconds worst case). The hybrid approach was chosen: child exit events
for agents spawned by the supervisor (immediate detection), PID polling only for
re-adopting agents on supervisor restart.

**Supervisor as message mediator (stdin/stdout dispatch):**
The supervisor could watch inboxes and dispatch messages to runners via stdin, reading
responses from stdout. Rejected because it makes the supervisor a critical path for
all message processing and prevents runners from working standalone. Self-sufficient
runners (ADR-005) are simpler and more resilient.

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-25 | Initial decision. |
| 2026-04-02 | **Failure signaling on agent death.** When maxRestarts is exhausted, the supervisor writes failure replies to the agent's outbox for orphaned `.in-progress/` messages (ADR-009). Minor fixes: removed `loom restart` reference, corrected systemd unit file to "will be provided". |
| 2026-04-03 | **Supervisor role clarified as message router.** Supervisor routes messages between agents and pipes via a routes table. Pipe logic is separate — pipes are named filesystem-backed entities (see ADR-010). |
