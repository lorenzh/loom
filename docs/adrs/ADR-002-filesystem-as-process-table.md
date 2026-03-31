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
  status        plain text — one of: running | idle | stopped | dead | error | restarting
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
  "in_reply_to": "1742860000000-a3f9c1d2e5b87041.msg",
  "body": "Unix was created at Bell Labs in 1969..."
}
```

The `in_reply_to` field references the inbox filename that triggered this response.
It is used for idempotent restart recovery: when a runner restarts, it checks
`inbox/.in-progress/` against outbox messages with matching `in_reply_to` to
determine if reprocessing is needed (see ADR-005).

The `v` field is the schema version. It allows safe migration when the message format changes:
- Missing `v` → treated as `v: 1` (backwards compat for files written before versioning was added)
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
1. Moves it to `inbox/.failed/{original_filename}`
2. Writes a companion error file `inbox/.failed/{original_filename}.error.json`:
   ```json
   {
     "ts": 1742878863000,
     "attempts": 3,
     "last_error": "anthropic API timeout after 30s",
     "error_type": "transient"
   }
   ```
3. Logs a structured error to the agent's daily log

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
