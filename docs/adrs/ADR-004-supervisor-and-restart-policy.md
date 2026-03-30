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

`loom supervisor` runs as a long-lived process. It reads agent definitions from
`$LOOM_HOME/agents/` and maintains a watch loop.

The supervisor is itself an OS process with a PID written to `$LOOM_HOME/supervisor.pid`.
If the supervisor dies, agents continue running — they just won't be restarted on next
crash until the supervisor is restarted.

### Health check

Every `heartbeatIntervalMs` (default 5000ms), the supervisor checks each registered agent:

1. Read `agents/{name}/pid` — get the OS PID
2. Check if that PID is alive (`process.kill(pid, 0)` — signal 0, no-op, just checks existence)
3. If dead → emit `'agent:died'` event and begin restart logic

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
An operator must manually run `loom restart {name}` to resume.

### Visibility

Crashes are always written to the filesystem — never silently swallowed:

```
agents/my-agent/
  status           ← "dead" or "restarting"
  crashes/
    1742900000-01HX.json   ← each crash is a file
```

`loom ps` shows restart count in the status column:
```
NAME            STATUS      MODEL           RESTARTS  UPTIME
my-agent        running     qwen3.5:9b      3         2m
news-monitor    dead        qwen2.5:3b      11        —
```

### Startup on boot

The supervisor does not install itself as a system service. That is the operator's job.
A systemd unit file template is provided in `docs/examples/loom-supervisor.service`.

## Consequences

**Good:**
- Crash recovery is automatic and visible — crash files are in the filesystem
- Operators can inspect exactly when and why each crash happened
- Backoff prevents runaway restart loops from hammering the GPU
- `restart: never` supports one-shot or batch agents that should not loop

**Bad:**
- The supervisor is itself a single point of failure. If it dies, agents are not
  restarted. Mitigated by running the supervisor under systemd (which will restart it).
- Heartbeat polling adds 5 seconds of worst-case detection latency. An agent could be
  dead for up to 5 seconds before the supervisor notices.
- Crash files accumulate. A future `loom gc` command should compact old crash records.

## Alternatives considered

**Using OS-level process supervision (systemd/launchd directly):**
Possible but requires root and system configuration. loom targets developer machines
and homelab servers where operators may not have root, and where one binary should
"just work". Rejected for the default path; supported as an optional deployment mode.

**Listening to child process `'exit'` events:**
Requires the supervisor to be the direct parent of all agents (spawned via `fork`).
This ties agent lifetime to supervisor lifetime — if the supervisor restarts, it
loses track of already-running agents. File-based PID tracking survives supervisor
restarts. Rejected in favour of PID polling.
