# Filesystem as State Store

**Status:** Draft
**Date:** 2026-03-26
**Author:** Lorenz Hilpert

---

## Context

Agents need to store state. The question is: where, and in what form?

Options range from:
- In-memory only (lost on restart)
- SQLite database
- Cloud storage (S3, Firestore, etc.)
- Vector database (for semantic memory)
- The filesystem

The choice of state store determines observability, portability, editability, and the tooling ecosystem an agent can leverage.

## Decision

**All loom agent state lives in the filesystem as plain, human-readable files.**

There is no database. There is no cloud backend. There is no opaque binary format. Every piece of agent state — running status, memory, conversation history, pending tasks, outputs — is a file in `~/.loom/agents/<name>/`.

### Directory Layout

Agent directories are keyed by **name**, not by PID or content hash (see ADR-002).
Status is stored as **separate plain-text files**, not a single `meta.json` — each
file can be read and written independently with standard Unix tools.

```
~/.loom/
├── config.json              # global configuration
├── plugins/                 # installed plugins (executables)
├── supervisor.pid           # supervisor OS PID (if running)
├── pipes/                   # pipe tracking logs (see pipe-engine ADR)
└── agents/
    └── <name>/              # one directory per agent
        ├── pid              # plain text — current OS process ID, empty if not running
        ├── status           # plain text — running | idle | stopped | dead | error | restarting
        ├── model            # plain text — model identifier in use
        ├── started_at       # plain text — ISO 8601 timestamp
        ├── stopped_at       # plain text — ISO 8601 timestamp, empty if still running
        ├── env              # KEY=VALUE environment variables
        ├── cwd -> <path>    # symlink to working directory
        ├── prompt.md        # system prompt
        ├── inbox/           # incoming messages as .msg files
        │   ├── {ts}-{ulid}.msg
        │   ├── .in-progress/    # messages currently being processed
        │   ├── .processed/      # successfully processed messages
        │   ├── .failed/         # messages that failed after retries (+ .error.json)
        │   └── .unreadable/     # messages that could not be parsed
        ├── outbox/          # response messages as .msg files
        │   └── {ts}-{ulid}.msg
        ├── memory/          # persistent memory files
        │   ├── MEMORY.md    # index (same format as Claude Code)
        │   └── *.md         # individual memory files
        ├── conversations/   # conversation history
        │   └── <date>.ndjson
        ├── tools/           # symlinks to available tools/plugins
        ├── children/        # symlinks to child agent PIDs
        ├── stdout           # live append-only log
        └── stderr           # errors and warnings
```

### File Formats

**Status files** — separate plain-text files (not a single JSON file):

```sh
$ cat agents/researcher/status
running

$ cat agents/researcher/model
qwen3.5:9b

$ cat agents/researcher/pid
12345
```

This design lets operators check agent state with `cat` and update it with
`echo running > status`. No JSON parsing required.

**inbox/\*.msg** — incoming message (see ADR-002 for canonical format):
```json
{
  "v": 1,
  "id": "a3f9c1d2e5b8...",
  "from": "cli",
  "ts": "2026-03-26T05:01:00.000Z",
  "body": "Research the history of Unix",
  "metadata": {}
}
```

**outbox/\*.msg** — response message:
```json
{
  "v": 1,
  "id": "b7c4e1f2a9d3...",
  "from": "researcher",
  "ts": "2026-03-26T05:01:03.000Z",
  "origin": "1742860000000-01JBXYZ9K2.msg",
  "body": "Unix was created at Bell Labs in 1969...",
  "metadata": {}
}
```

**conversations/\<date\>.ndjson** — newline-delimited JSON, one message per line:
```
{"role":"user","content":"Research the history of Unix","ts":"2026-03-26T05:01:00Z"}
{"role":"assistant","content":"Unix was created at Bell Labs...","ts":"2026-03-26T05:01:03Z"}
```

**memory/\*.md** — markdown with YAML frontmatter (same format as Claude Code auto-memory):
```markdown
---
name: User preferences
description: How the user likes responses formatted
type: user
---

User prefers bullet points over paragraphs. Prefers short responses.
```

### Atomicity

File writes use an atomic rename pattern:
1. Write to `<file>.tmp`
2. `rename(<file>.tmp, <file>)` — atomic on POSIX filesystems

This prevents corrupted reads during writes. No locking is required for writes.

For inbox ordering, files are named `{timestamp_ms}-{ulid}.msg`. ULIDs are
lexicographically sortable and globally unique without coordination between
agents (see ADR-002).

## Consequences

### Good

**Everything is inspectable with standard tools.**
- `cat ~/.loom/agents/researcher/status` — see agent status
- `tail -f ~/.loom/agents/researcher/logs/2026-03-26.ndjson` — watch live activity
- `ls ~/.loom/agents/researcher/inbox/` — see pending tasks
- `wc -l ~/.loom/agents/researcher/conversations/*.ndjson` — count messages

**Memory is directly editable.** Want to inject context into an agent? Write a file into its `memory/` directory. Want to correct a bad memory? Open it in vim. No API calls, no GUI required.

**Backup and sync are trivial.** `rsync`, `git`, Time Machine — anything that handles files works. Agents are portable: copy the directory, same agent.

**Version control is natural.** Agent state can be committed to git. Memory evolution is diffable. Breaking changes in behavior can be traced to memory file changes.

**Debugging is structural.** When an agent behaves unexpectedly, the first step is `ls` and `cat`. The state is all there.

**No running daemon required for inspection.** `loom ps` works even if nothing is running — it reads the status files directly.

### Tricky

**File count can grow large.** An active agent with many tasks will accumulate thousands of small files in `inbox/` and `outbox/`. We mitigate this with:
- Automatic archival: processed messages move to `outbox/archive/YYYY-MM/` after 24 hours
- Conversation rotation: daily `.ndjson` files, with older ones gzip-compressed
- `loom gc` command to prune stale state

**No indexing.** Finding "all tasks where the result contained X" requires grepping thousands of files. This is acceptable for local-first scale (tens to hundreds of agents) but would not scale to thousands. For now, this is a feature (grep is universal), not a bug.

**Race conditions on shared files.** Multiple processes writing to the same agent's inbox concurrently could produce collisions. Mitigated by using `{timestamp_ms}-{ulid}.msg` filenames — ULIDs are globally unique without coordination, so no locking is needed for filename assignment. The write itself is atomic via rename.

**Filesystem limits.** Deep nesting, long filenames, and inode limits are real on some systems. We keep all paths short and avoid deep nesting beyond what's shown in the layout.

**Symlinks for cwd can become stale.** If a working directory is deleted, the `cwd` symlink breaks. We detect and log this; it does not crash the agent.

## Alternatives Considered

### SQLite

Single-file, transactional, fast, well-supported. Would solve the race condition and indexing problems. Rejected because:
- Not directly inspectable without `sqlite3` CLI
- Not editable with standard text editors
- Not diffable with git
- Breaks the "everything is a file" principle

### In-process memory only

Simple and fast. Rejected because:
- State lost on restart
- Not observable externally
- Doesn't survive process crashes

### Cloud storage (S3, etc.)

Rejected outright: violates the local-first principle. Network required for basic operations.

### JSON single-file per agent

One big `agent.json` file. Simple, but:
- Not streamable (can't `tail -f`)
- Not incrementally writable (must read/modify/write entire file)
- Grows unbounded without pruning strategy
- Race conditions on concurrent writes

## References

- [Local-first software](https://www.inkandswitch.com/local-first/) — Ink & Switch, 2019
- [Plan 9 /proc filesystem](https://9p.io/sys/man/3/proc) — processes exposed as files
- Linux `/proc` and `/sys` — runtime state as filesystem
- SQLite's write-ahead log — inspiration for atomic write patterns
