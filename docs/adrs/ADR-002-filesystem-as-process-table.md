# ADR-002: Filesystem as process table

**Status:** Accepted
**Date:** 2026-03-25

## Context

Agent frameworks typically store runtime state in memory (lost on crash), in databases (hidden from operators), or in cloud services (requires connectivity). This makes it hard to observe what agents are doing, debug failures, or recover from crashes.

Unix has solved this problem for 50 years: processes are files (`/proc`), state is files, communication is files. Any tool that can read a file can observe the system.

## Decision

The loom process table is a directory. Each agent has a subdirectory under `$LOOM_HOME/agents/{name}/` containing plain files:

```
$LOOM_HOME/agents/{name}/
  pid           plain text — current OS process ID, empty if not running
  status        plain text — one of: running | idle | stopped | pending | dead | error | restarting
  model         plain text — model identifier in use
  started_at    plain text — ISO 8601 timestamp
  stopped_at    plain text — ISO 8601 timestamp, empty if still running
  inbox/        directory — incoming messages as .msg files
    .in-progress/ — messages currently being processed by the runner
    .processed/   — successfully processed messages
    .failed/      — messages that failed after all retries (with .error.json companions)
    .unreadable/  — messages that could not be parsed
  outbox/       directory — outgoing messages as .msg files
  memory/       directory — persistent key-value state as .json files
  logs/         directory — append-only NDJSON log files, one per day
```

The runtime provides two layers for working with the process table:

- **`AgentProcess`** — reads/writes the state files for a single agent.
- **`ProcessTable`** — manages multiple `AgentProcess` instances under a shared
  home directory. Provides enumeration (`agents()`, `entries()`), lookup (`get()`,
  `has()`), and removal (`remove()`).

Message files in `inbox/` and `outbox/` follow this naming convention:
```
{timestamp_ms}-{id}.msg    e.g. 1742860000000-a3f9c1d2e5b87041.msg
```

The timestamp prefix provides human-readable "when" context in directory listings.
The `id` segment is a unique identifier for deduplication and sort-order stability.

> **Note:** The current runtime generates `id` as a 16-character truncated hex UUID
> (`crypto.randomUUID().slice(0, 16)`). A future migration will switch to
> [ULID](https://github.com/ulid/spec) (Crockford Base32) for lexicographic
> sortability within the same millisecond. Until then, ordering relies on the
> timestamp prefix and the existing hex IDs are sufficient for uniqueness.

### Message file format

**Inbox message:**

```json
{
  "v": 1,
  "id": "a3f9c1d2e5b87041",
  "from": "cli",
  "ts": 1742860000000,
  "body": "hello world"
}
```

**Outbox message (response):**

```json
{
  "v": 1,
  "id": "b7c4e1f2a9d31052",
  "from": "researcher",
  "ts": 1742860003000,
  "origin": "1742860000000-a3f9c1d2e5b87041.msg",
  "body": "Unix was created at Bell Labs in 1969..."
}
```

The `origin` field is a slash-delimited path of message filenames tracing the
pipeline run (see ADR-009). The last segment is the inbox filename that
triggered this response — used for idempotent restart recovery: when a runner
restarts, it checks `inbox/.in-progress/` against outbox messages whose origin
ends with the in-progress filename to determine if reprocessing is needed
(see ADR-005).

The `v` field is the schema version. It allows safe migration when the message format changes:
- Missing `v` → fails validation (`isMessage()` requires `v` to be present and numeric). The message is quarantined as unreadable.
- `v` newer than the runtime's `MESSAGE_VERSION` → runtime throws with a clear error message asking the operator to upgrade loom
- `v` equal or older → parsed normally

### Invalid message handling

If a `.msg` file contains invalid JSON or fails schema validation, the runtime:
1. Moves it to `inbox/.unreadable/{original_filename}` — never deleted, preserved for inspection
2. Logs a structured error to the agent's daily log: `{ "level": "error", "event": "unreadable_message", "file": "...", "reason": "..." }`
3. Continues processing remaining inbox messages — one bad file does not block the queue

This means operators can always inspect what went wrong with `cat inbox/.unreadable/somefile.msg`.

### Failed message handling

If a message is valid but processing fails after all retries (e.g. LLM timeout,
repeated API errors), the runner:
1. Writes a **failure reply** to `outbox/` with `error: true`, building the
   `origin` path from the original message (see ADR-009). This signals
   downstream agents (e.g. fan-in aggregators) through the normal pipe engine
   flow. **This step is first** so the downstream signal is preserved even if
   the runner crashes before completing the remaining steps.
2. Moves the message to `inbox/.failed/{original_filename}`
3. Writes a companion error file `inbox/.failed/{original_filename}.error.json`:
   ```json
   {
     "ts": 1742878863000,
     "attempts": 3,
     "last_error": "anthropic API timeout after 30s",
     "error_type": "transient"
   }
   ```
4. Logs a structured error to the agent's daily log

If the runner crashes after step 1 but before step 2, the message remains in
`inbox/.in-progress/`. On restart, recovery finds the matching outbox reply
(via `origin` last segment) and moves the message to `inbox/.processed/`. The
downstream signal is preserved; only the `.failed/` debug artifact is lost,
which is acceptable.

`.failed/` is a **local debug artifact** — it preserves the original message
and error details for operator inspection. The outbox failure reply is the
**inter-agent signal** that communicates the failure downstream.

An operator can reprocess failed messages by moving them back to `inbox/`:
```sh
mv agents/researcher/inbox/.failed/1742860000000-a3f9c1d2e5b87041.msg agents/researcher/inbox/
```

## Consequences

**Good:**
- `cat agents/my-agent/status` tells you immediately what an agent is doing
- `ls agents/my-agent/inbox/` shows pending messages — nothing is lost on crash
- `tail -f agents/my-agent/logs/2026-03-25.ndjson` streams live agent activity
- State survives restarts: inbox messages persist until processed
- No database, no special tooling required to observe the system
- Works fully offline — no cloud dependency

**Bad:**
- Filesystem polling has latency (~100ms). Not suitable for sub-100ms message delivery. Acceptable for conversational agents; not for high-frequency trading bots.
- File-per-message creates many small files under heavy load. Mitigated by periodic compaction of `.processed/` directories.
- Cross-machine agents require a shared filesystem (NFS, SSHFS) or a different transport. Out of scope for v1.

## Alternatives considered

**SQLite:** Single-file, transactional, fast. But opaque — you need tooling to read it. Ruled out.

**Redis/TCP pub-sub:** Fast, flexible. But requires a running server, network connectivity, and is invisible to standard Unix tools. Ruled out for core; may be added as optional remote transport later.

**In-memory EventEmitter:** Simple, zero latency. But state is lost on crash and invisible to operators. Ruled out.

---

## Changelog

| Date | Change |
|---|---|
| 2026-03-31 | **Added `pending` to status values.** ADR-004 and ADR-006 require writing `status: pending` for newly created detached agents. Added to the canonical set. |
| 2026-03-31 | **Fixed `v` field backwards-compat rule.** Changed "missing `v` → treated as `v: 1`" to "missing `v` → fails validation, message is quarantined." The `v` field is required for all messages. |
| 2026-04-02 | **Added outbox failure reply to failed message handling.** The runner now writes a failure reply to `outbox/` in addition to moving to `.failed/`. `.failed/` is a local debug artifact; the outbox reply is the inter-agent signal. |
| 2026-04-02 | **Outbox reply written before `.failed/` move.** Reordered to write the downstream signal first for crash safety. If the runner crashes after the outbox write but before moving to `.failed/`, restart recovery handles it. |
| 2026-04-02 | **Replaced `in_reply_to` with `origin` in message format.** `origin` is a path-based field that subsumes `in_reply_to` — last segment is the parent message. See ADR-009. |
