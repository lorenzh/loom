# ADR-007: Built-in tools and workspace sandboxing

**Status:** Proposed
**Date:** 2026-03-31

---

## Context

ADR-005 defines tool execution as spawning plugin executables with JSON on
stdin/stdout. This works well for third-party and optional tools, but every
agent needs a baseline set of filesystem tools to be useful — reading files,
editing code, searching content. These operations happen on nearly every LLM
turn and must be fast.

Coding agents (Claude Code, Cursor, Windsurf) have converged on a common tool
set: read, edit, grep, glob, bash. This is not a coincidence — these tools map
directly to what a developer does in a terminal, and LLMs are trained on
enormous amounts of terminal interaction. Providing the same primitives to loom
agents gives them the same capabilities.

The second question is scope: what can an agent's tools access? An unsandboxed
agent with `read` and `bash` can access anything the host user can. This is
fine for a developer sitting at a terminal, but not for a managed agent running
in the background. We need a default boundary.

## Decision

### Built-in tools

The runner includes six built-in tools implemented as functions inside the
runner process. They are always available to every agent. No subprocess is
spawned — tool calls execute in-process for minimal latency.

| Tool | Purpose | Key parameters |
|------|---------|----------------|
| **read** | Read file contents | `path`, `offset`, `limit` |
| **write** | Create or overwrite a file | `path`, `content` |
| **edit** | Replace a string in an existing file | `path`, `old_string`, `new_string` |
| **glob** | Find files matching a pattern | `pattern`, `path` |
| **grep** | Search file contents by regex | `pattern`, `path`, `glob` |
| **bash** | Execute a shell command | `command`, `timeout` |

Built-in tools use the same JSON Schema interface that plugins use (see
ADR-005). The runner generates their tool definitions and merges them with any
plugin tool definitions before sending the combined list to the LLM.

#### read

Reads file contents with optional offset and line limit. Returns content with
line numbers. Can read text files, and when supported by the LLM, images and
PDFs.

```json
{
  "name": "read",
  "parameters": {
    "path": "src/index.ts",
    "offset": 0,
    "limit": 200
  }
}
```

Returns the file content as a string with line numbers prefixed.

#### write

Creates a new file or overwrites an existing file. Creates parent directories
if they don't exist.

```json
{
  "name": "write",
  "parameters": {
    "path": "src/config.ts",
    "content": "export const PORT = 3000;\n"
  }
}
```

#### edit

Performs exact string replacement in an existing file. The `old_string` must
match exactly one location in the file (unless `replace_all` is set). This is
safer than write for modifications — it prevents accidentally overwriting
unrelated content.

```json
{
  "name": "edit",
  "parameters": {
    "path": "src/config.ts",
    "old_string": "const PORT = 3000",
    "new_string": "const PORT = 8080",
    "replace_all": false
  }
}
```

Fails if `old_string` is not found or matches multiple locations (when
`replace_all` is false).

#### glob

Finds files matching a glob pattern. Returns file paths sorted by modification
time. Useful for discovering project structure.

```json
{
  "name": "glob",
  "parameters": {
    "pattern": "**/*.ts",
    "path": "src"
  }
}
```

#### grep

Searches file contents using regular expressions. Supports filtering by file
glob and limiting output.

```json
{
  "name": "grep",
  "parameters": {
    "pattern": "function\\s+handle",
    "path": "src",
    "glob": "*.ts"
  }
}
```

Returns matching lines with file paths and line numbers.

#### bash

Executes a shell command and returns stdout, stderr, and exit code. The command
runs in the agent's workspace directory with the agent's environment variables.

```json
{
  "name": "bash",
  "parameters": {
    "command": "bun test --filter auth",
    "timeout": 30000
  }
}
```

Bash is **opt-in** — disabled by default, enabled per-agent via configuration.
When disabled, the tool is not included in the schema sent to the LLM. The
operator assumes responsibility for what the agent can do with shell access.

### Workspace sandboxing

Every agent has a **workspace** — a directory that its built-in tools are
scoped to. All paths passed to built-in tools are resolved relative to the
workspace. Path traversal outside the workspace is rejected.

```
read("src/index.ts")           → OK (relative to workspace)
read("/etc/passwd")            → REJECTED (absolute path outside workspace)
read("../../etc/passwd")       → REJECTED (traversal outside workspace)
```

#### Default workspace paths

| Mode | Default workspace | Override |
|------|-------------------|----------|
| `loom run` (foreground) | Current working directory (`cwd`) | `--workspace /path` |
| `loom run --detach` | `$LOOM_HOME/agents/{name}/workspace/` | `--workspace /path` |
| `loom up` (via `loom.yml`) | `$LOOM_HOME/agents/{name}/workspace/` | `workspace:` key in `loom.yml` |

The foreground default of `cwd` is intentional: you `cd` into a project and
run an agent against it, just like running any other CLI tool.

For managed agents, the workspace is a dedicated directory inside the agent's
home. This prevents managed agents from accidentally modifying the operator's
files. The operator can override this to point at a project directory when they
want the agent to work on real files.

#### Workspace vs agent directories

The workspace is **separate from the agent's internal directories**:

```
$LOOM_HOME/agents/{name}/
  pid
  status
  model
  inbox/
  outbox/
  logs/
  plugins/            ← plugin scoped directories (plugins/{plugin_name}/)
  workspace/          ← built-in tools are scoped here
```

Built-in tools cannot access `inbox/`, `outbox/`, `logs/`, or other agent
internals. These are managed by the runner and by plugin tools with explicit
access grants.

### Plugin tools and scoped directories

Plugin tools (ADR-005) operate on their own scoped directories, separate from
the workspace. The plugin declares the directory it needs; the runner creates
it and passes the path at invocation.

```
$LOOM_HOME/agents/{name}/
  plugins/
    memory/           ← memory plugin's scoped directory
    browser/          ← browser plugin's scoped directory
  workspace/          ← built-in tools' scope
```

All plugin directories live under `plugins/{plugin_name}/`. The runner creates
the directory on first use and passes the path at invocation.

For example, a **memory** plugin:
- The runner creates `$LOOM_HOME/agents/{name}/plugins/memory/` and passes it
  as `scope_dir` in the plugin's invocation JSON
- The plugin reads/writes within its scoped directory
- By default, the plugin cannot see `workspace/`

#### Plugin workspace access

Plugins can be configured to also receive access to the agent's workspace.
This is opt-in per plugin — the operator grants it in the agent or weave
configuration:

```yaml
# loom.yml
agents:
  researcher:
    model: anthropic/claude-sonnet-4-20250514
    plugins:
      memory: {}                          # scoped dir only
      code-review:
        workspace_access: true            # gets both scoped dir + workspace
```

When `workspace_access` is enabled, the runner passes both paths in the
plugin's invocation JSON:

```json
{
  "scope_dir": "$LOOM_HOME/agents/researcher/plugins/code-review/",
  "workspace_dir": "/path/to/project"
}
```

The plugin decides how to use each. A code-review plugin might read project
files from the workspace while storing its review state in its scoped
directory. The separation still holds — the scoped directory is the plugin's
private state, the workspace is shared read-write access to the project.

Without `workspace_access`, the plugin only receives `scope_dir`. This is
the safe default: most plugins (memory, caching, scheduling) don't need to
see project files.

This separation means:
- **Workspace** = the agent's view of the outside world (project files, data)
- **Plugin scoped directories** = the plugin's private internal state
- **Workspace access** = opt-in grant for plugins that need to operate on project files

### Bash sandboxing

Bash is the most powerful tool and the hardest to sandbox. A shell command can
access the network, spawn processes, and read files outside the workspace via
subprocesses.

loom takes the pragmatic approach: **bash is opt-in, and the operator assumes
responsibility**. When enabled:

- The command runs with `cwd` set to the workspace
- The agent's `env` is applied
- No network or process restrictions are enforced by the runner

This matches how coding agents work today — bash is available, powerful, and
trusted. Operators who need stronger isolation can run agents in containers
or use OS-level sandboxing (namespaces, seccomp, etc.). A future ADR may
define a restricted bash mode with network and filesystem constraints.

## Consequences

### Good

**Fast tool execution.** Built-in tools run in-process with no subprocess
overhead. A read-edit-grep cycle that would require three process spawns as
plugins executes in microseconds.

**Familiar tool set.** Developers and LLMs both know these tools. The same
read/edit/grep/glob/bash pattern used by coding agents works here. No new
abstractions to learn.

**Safe by default.** Workspace sandboxing means an agent can't accidentally
(or intentionally) modify files outside its designated area. Operators
explicitly choose what the agent can access.

**Clean separation.** Workspace for project files, plugin directories for
internal state. Neither can see the other. This prevents an agent from
accidentally overwriting its own memory files via `edit`, or reading its raw
inbox messages.

### Tricky

**Bash escapes the sandbox.** A `bash` command can `curl`, write to `/tmp`,
or read outside the workspace. This is accepted — bash is opt-in and operators
take responsibility. Stronger sandboxing is an OS-level concern.

**Workspace override requires trust.** When an operator sets
`--workspace /path/to/my-project`, the agent gets read-write access to that
entire directory tree. This is powerful and necessary, but the operator must
understand the implications.

**Built-in tools can't be removed.** All six tools (five if bash is disabled)
are always present. An agent that should only call LLMs and send messages still
sees read/write/edit/grep/glob in its tool list. This is minor — the LLM
simply won't use tools that aren't relevant to its task.

**Plugin directory proliferation.** Each plugin gets its own directory under
`plugins/`. Many plugins means many subdirectories, but they are contained
under a single parent — `ls agents/{name}/plugins/` shows the full layout.

## Alternatives considered

**All tools as plugins (subprocess spawn):**
Consistent with ADR-005, but unacceptably slow for tools called on every LLM
turn. A read-edit-grep cycle would spawn three processes. Rejected.

**No workspace sandboxing (full filesystem access):**
Simpler implementation, but a managed background agent with write access to
`/` is a liability. The default should be safe. Rejected for default behavior;
available via `--workspace /`.

**Restricted bash via seccomp/namespaces:**
The runner could enforce network and filesystem restrictions on bash commands
using OS primitives. Feasible but complex, platform-specific, and out of scope
for v1. Deferred to a future ADR.

**Capability-based tool permissions:**
Each agent declares which tools it needs, and the runner only enables those.
Adds configuration burden for marginal safety gain — the LLM simply ignores
tools it doesn't need. Rejected for v1, may revisit for multi-tenant setups.

## References

- ADR-001: Unix process model — agents have `cwd` and `env`
- ADR-002: Filesystem as process table — agent directory layout
- ADR-005: Runner architecture — tool execution protocol and plugin spawning
- ADR-006: CLI and lifecycle — `loom run` modes and workspace defaults
