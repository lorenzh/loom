# ADR-007: Garbage collection and archival

**Status:** Accepted
**Date:** 2026-04-03

---

## Context

loom stores all state as files: processed messages in `.processed/`,
crash records in `crashes/`, operator step output in `steps/`, dedupe
seen-sets in `state/dedupe/seen.jsonl`, and tracking logs per route. None
of these are ever deleted by the runtime — they accumulate indefinitely.

On a long-running system this becomes a problem:

- **Disk fills silently.** Agents keep running but `/` fills up. The
  operator blames loom.
- **Directory listings slow down.** `readdir()` on thousands of `.msg`
  files adds latency to polling.
- **Operator confusion.** Should they manually `rm -rf .processed/`?
  What about crash records they haven't inspected?

Multiple ADRs defer to this decision:

- ADR-001: "A future GC command will clean up old crash records and
  processed messages."
- ADR-002: "File-per-message creates many small files. Mitigated by
  periodic compaction."
- ADR-003: "A future compaction pass can archive these to NDJSON logs."
- ADR-004: "Crash files accumulate. A future `loom gc` should compact."
- ADR-010: "Dedupe keys, tracking logs, step files. Deferred to `loom gc`."

## Decision

### `loom gc` command

`loom gc` is a CLI command that prunes old state. It is safe to run while
agents are running — it only touches files that are no longer actively
referenced.

```sh
loom gc                   # prune all agents and pipes
loom gc --dry-run         # show what would be deleted
loom gc --agent <name>    # prune a specific agent
```

### What gets pruned

| Location | Default retention | Action |
|---|---|---|
| `inbox/.processed/` | 7 days | Archive to `inbox/archive/{YYYY-MM-DD}.ndjson.gz` |
| `outbox/` (already routed) | 7 days | Archive to `outbox/archive/{YYYY-MM-DD}.ndjson.gz` |
| `crashes/` | 90 days | Delete |
| `logs/` | 30 days | Compress to `.ndjson.gz` after 1 day, delete after 30 |
| `steps/` (pipe) | 7 days | Delete |
| `state/dedupe/seen.jsonl` | 10,000 entries | Truncate to last N entries |
| Tracking logs (`routes/`) | 30 days | Truncate to last 30 days |

Retention periods are configurable via `loom.yml`:

```yaml
gc:
  retention:
    processed: 7d
    outbox: 7d
    crashes: 90d
    logs: 30d
    steps: 7d
    dedupe_entries: 10000
```

### Archival format

Archived messages are stored as gzip-compressed NDJSON — one message
per line, preserving the full `Message` object:

```
inbox/archive/2026-04-01.ndjson.gz
outbox/archive/2026-04-01.ndjson.gz
```

This reduces thousands of small files to one compressed file per day.
Archived messages can be searched with:

```sh
zcat agents/researcher/inbox/archive/2026-04-01.ndjson.gz | jq '.body'
```

### Archival is one-way

Archived messages are for inspection only — they are not automatically
re-injected into the inbox. An operator who needs to reprocess can
extract and re-send manually:

```sh
zcat archive/2026-04-01.ndjson.gz | jq -c '.[]' | while read msg; do
  echo "$msg" > agents/researcher/inbox/$(date +%s)-reinjected.msg
done
```

### Idempotency

`loom gc` is idempotent and safe to run from cron:

```sh
# Run GC daily at 3am
0 3 * * * cd /home/user/project && loom gc
```

It checks file modification times, not counters. Running it twice in
a row is harmless.

### Step file cleanup for pipes

Pipe `steps/` directories are pruned entirely once the original inbox
message has been in `.processed/` for longer than the retention period.
The pipe process does not reference old step files — they exist only
for post-hoc debugging.

### Dedupe state compaction

The `seen.jsonl` file for dedupe operators grows one line per message.
`loom gc` truncates it to the last N entries (default 10,000). This means
very old message IDs may pass through the dedupe again — acceptable for
most use cases. Operators who need longer dedupe windows can increase
`dedupe_entries`.

## Consequences

### Good

- **Disk usage stays bounded.** Operators don't need to think about cleanup.
- **Observable.** Archives are readable with `zcat` and `jq`.
- **Safe.** Only touches files past retention. Running agents are not affected.
- **Cron-friendly.** Idempotent, no locking needed.

### Tricky

- **Archival is lossy for filenames.** The original `.msg` filename (with
  its timestamp-ULID) is not preserved in the NDJSON archive. The `id`
  and `ts` fields inside the message are preserved.
- **No automatic GC.** Operators must run `loom gc` or set up cron.
  A future version may add `gc: auto` in `loom.yml` for the supervisor
  to run GC on a schedule.
- **Dedupe truncation has a window.** Messages older than 10,000 entries
  may be re-accepted by a dedupe operator after compaction.

## Alternatives considered

**Automatic background GC in supervisor:** Simpler for operators but adds
complexity to the supervisor. Hard to predict when GC will run. Deferred
to a future `gc: auto` option.

**Keep everything forever:** Works for small systems but doesn't scale.
Operators will build ad-hoc cleanup scripts anyway. Rejected.

**Delete instead of archive:** Faster, simpler. But operators lose the
ability to inspect old messages. Archive-then-delete is a better default.

**Per-message TTL field:** Each message specifies its own retention. Over-
engineered for v1 — global retention is sufficient. Rejected.

## References

- ADR-002: Filesystem as process table — file-per-message accumulation
- ADR-003: Inbox watcher — `.processed/` accumulation
- ADR-004: Supervisor — crash record accumulation
- ADR-010: Pipe runner — step files and dedupe state accumulation
- ADR-012: Filesystem state store — directory layout

---

## Changelog

| Date | Change |
|---|---|
| 2026-04-03 | Initial decision. Defines `loom gc` command, retention defaults, NDJSON archive format, dedupe compaction, and cron-friendly idempotency. |
