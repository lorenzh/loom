# ADR-003: Inbox watcher via filesystem polling

**Status:** Accepted
**Date:** 2026-03-25

## Context

Agents need to receive messages. Once a message file lands in `inbox/`, something
must notice it and trigger the agent. The question is how that notification happens.

Options:
1. **Filesystem events** (`fs.watch`, `inotify`, `kqueue`)
2. **Polling** — stat/readdir on a timer
3. **Socket/pipe** — sender signals the receiver directly

## Decision

Use polling at a configurable interval (default 200 ms).

The implementation is split into two layers:

- **`InboxWatcher`** — polls a single inbox directory, consumes `.msg` files, and
  emits `(filename, message)` events. This is the low-level primitive.
- **`InboxRouter`** — manages one `InboxWatcher` per agent, forwarding events with
  the agent name prepended: `(agentName, filename, message)`. This is the multi-agent
  coordinator.

### Three-phase message lifecycle

The message lifecycle uses three filesystem phases for reliable delivery
with idempotent restart recovery (see ADR-005):

```
inbox/
  {ts}-{id}.msg             ← pending — not yet claimed
  .in-progress/
    {ts}-{id}.msg           ← claimed — runner is processing this now
  .processed/
    {ts}-{id}.msg           ← done — successfully processed
  .failed/
    {ts}-{id}.msg           ← failed — exhausted all retries
    {ts}-{id}.msg.error.json    ← companion error details
  .unreadable/
    {ts}-{id}.msg           ← could not be parsed as valid JSON
```

```
InboxWatcher.poll()
  list *.msg files in inbox/ (sorted by filename → oldest first)
  for each file:
    read + parse JSON
    emit('message', filename, message)

InboxRouter.add(agent)
  create InboxWatcher.forAgent(home, agent)
  forward events with agent name prefix
  start watcher
```

The watcher emits events; the **runner** (ADR-005) owns the three-phase
transitions. When the runner receives a message event, it:

1. Calls `claim()` — moves the file to `inbox/.in-progress/`
2. Processes the message (LLM call, tool execution, writes response to `outbox/`)
3. Calls `acknowledge()` — moves the file to `inbox/.processed/`

This separation keeps `InboxWatcher` simple (detection only) while giving the
runner control over the claim-process-acknowledge lifecycle.

### Restart recovery

On startup, the runner checks `inbox/.in-progress/` for messages that were
mid-processing when it last crashed:

```
for each file in inbox/.in-progress/:
  scan outbox/ for any message with in_reply_to == filename
  if found → response already written, just move to .processed/
  if not found → processing did not complete, move back to inbox/ for reprocessing
```

This provides at-least-once delivery with no duplicate responses: if the
outbox already contains the response, the runner skips reprocessing and just
finishes the acknowledgment.

## Rationale

**Why not `fs.watch`?**

`fs.watch` is notoriously unreliable across platforms (macOS, Linux, Windows each have
quirks). It does not work over NFS or SSHFS, which are valid loom deployment targets.
It can miss events under high write load. The added complexity is not worth 200 ms
of latency for conversational agents.

**Why not sockets/pipes?**

The core loom principle is that everything is a file. A socket-based notification
channel would require the receiver to be running before the sender sends. With
file-based polling, messages persist even if the agent is not yet started — they
are delivered on next poll. This is the same reason Unix mail spools work the way
they do.

**Why move to `.processed/` rather than delete?**

Deleted files are unrecoverable. A moved file can be inspected after the fact to
debug what the agent received. `.processed/` is a hidden directory (dot-prefixed)
so `ls inbox/` still gives a clean view of pending messages.

## Consequences

- Message delivery latency: up to `pollIntervalMs` (default 200 ms). Acceptable
  for conversational agents. For tighter latency, callers can set `pollIntervalMs: 50`.
- At high message volume, many small files accumulate in `.processed/`. A future
  compaction pass can archive these to NDJSON logs.
- `InboxWatcher` extends `EventEmitter`, emits `(filename, message)`. Single-agent
  callers (e.g. `AgentRunner`) use it directly via `InboxWatcher.forAgent(home, name)`.
  Errors are surfaced via the standard `'error'` event.
- `InboxRouter` manages multiple `InboxWatcher` instances, emits
  `(agentName, filename, message)`. Multi-agent callers (e.g. supervisor) use it
  via `router.add(agent)` / `router.remove(agent)` / `router.stop()`.
- **`home` parameter convention:** `InboxWatcher.forAgent(home, name)` and
  `InboxRouter` expect `home` to be the agents root directory
  (`$LOOM_HOME/agents`), not `$LOOM_HOME` itself. The watcher constructs the
  inbox path as `{home}/{name}/inbox/`.

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-31 | **Removed "not yet implemented" note.** The three-phase lifecycle (claim → process → acknowledge) is the decided design, not a future target. |
| 2026-03-31 | **Clarified watcher vs runner responsibility.** `InboxWatcher` detects and emits; the runner owns the claim/process/acknowledge transitions. Updated pseudocode to reflect this separation. |
| 2026-03-31 | **Documented `home` parameter convention.** `home` is `$LOOM_HOME/agents`, not `$LOOM_HOME`. |
