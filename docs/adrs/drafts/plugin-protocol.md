# Plugin Protocol — Tools as Executables

**Status:** Draft
**Date:** 2026-03-26
**Author:** Lorenz Hilpert

---

## Context

AI agents are significantly more capable when they have tools — the ability to search the web, read files, run code, call APIs, send notifications, etc.

We need a plugin system that:
1. Is easy to write (no special SDK, any language)
2. Integrates with the filesystem-as-state principle
3. Doesn't require the runtime to know about plugins at compile time
4. Allows community-built tools
5. Works with existing LLM tool-calling protocols (Anthropic's tool use API)

The Unix pattern of "everything is a file" and "compose through pipes" gives us a clear answer: **plugins are executables**.

## Decision

**A loom plugin is any executable in `~/.loom/plugins/` that follows the loom tool protocol.**

The protocol:
1. The runtime discovers tools by scanning `~/.loom/plugins/` for executable files/directories
2. To get the tool's schema, the runtime calls `<plugin> describe` — returns a JSON tool definition
3. To invoke the tool, the runtime calls `<plugin> invoke` with JSON input on stdin — returns JSON output on stdout

That's it. Three conventions: `describe`, `invoke`, JSON on stdin/stdout.

### Plugin Structure

A plugin can be a single file or a directory:

```
~/.loom/plugins/
├── loom-search          # single executable
├── loom-browse/         # directory with multiple files
│   ├── loom-browse      # main executable (must match dir name)
│   ├── README.md
│   └── lib/
└── loom-notify          # single executable
```

### The Describe Protocol

```bash
$ loom-search describe
```

Returns a JSON object following the Anthropic tool definition format:

```json
{
  "name": "search",
  "description": "Search the web for information. Returns a list of results with titles, snippets, and URLs.",
  "input_schema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The search query"
      },
      "num_results": {
        "type": "integer",
        "description": "Number of results to return (default: 5, max: 20)"
      }
    },
    "required": ["query"]
  }
}
```

The runtime caches this schema. It is re-fetched if the plugin's mtime changes.

### The Invoke Protocol

```bash
$ echo '{"query": "history of Unix", "num_results": 3}' | loom-search invoke
```

Returns a JSON object:

```json
{
  "status": "ok",
  "result": [
    {
      "title": "History of Unix - Wikipedia",
      "url": "https://en.wikipedia.org/wiki/History_of_Unix",
      "snippet": "Unix was created at Bell Labs in 1969..."
    }
  ]
}
```

On error:

```json
{
  "status": "error",
  "error": "Rate limit exceeded. Retry after 60s.",
  "retry_after": 60
}
```

### Environment

Plugins receive the invoking agent's environment variables, plus:

```
LOOM_AGENT_PID=7a2f
LOOM_AGENT_NAME=researcher
LOOM_AGENT_CWD=/workspace/foo
LOOM_STATE_DIR=~/.loom/agents/7a2f
```

This lets plugins write to the agent's state directory if needed (e.g., a `browser` plugin that saves screenshots to `~/.loom/agents/7a2f/artifacts/`).

### Tool Registration

Agents get access to tools in two ways:

**1. Global tools** — plugins in `~/.loom/plugins/` are available to all agents by default.

**2. Scoped tools** — at spawn time:
```bash
loom spawn --name researcher --tools search,browse
# Only search and browse are available to this agent
```

The available tools are symlinked into `~/.loom/agents/<pid>/tools/`:
```
tools/
├── search -> ~/.loom/plugins/loom-search
└── browse -> ~/.loom/plugins/loom-browse/loom-browse
```

The runtime reads the agent's `tools/` directory to know which tools to expose in the system prompt and LLM API calls.

### Project-local Plugins

A `.loom/plugins/` directory in the working directory takes precedence over global plugins. This lets projects ship their own tools:

```
my-project/
├── .loom/
│   └── plugins/
│       └── run-tests    # project-specific tool
└── src/
```

### Streaming

For long-running tools (e.g., a browser tool that takes a screenshot), plugins can stream progress:

```bash
$ echo '{"url": "https://example.com"}' | loom-browse invoke
```

Streaming output uses NDJSON — one JSON object per line, with a final `{"status": "ok", ...}` line:

```
{"type": "progress", "message": "Navigating to URL..."}
{"type": "progress", "message": "Page loaded. Taking screenshot..."}
{"type": "progress", "message": "Extracting content..."}
{"status": "ok", "result": {"screenshot": "base64...", "text": "..."}}
```

The runtime displays progress lines in the agent's `stdout` but only passes the final `status: ok` result to the LLM.

## Consequences

### Good

**Any language, any runtime.** A plugin can be a bash script, a Python script, a Go binary, a Node.js script with a shebang. If it's executable and speaks JSON on stdin/stdout, it works.

**No SDK required.** You don't need to import loom to write a plugin. You don't need to know how loom works internally. You just need to handle `describe` and `invoke`.

**Easy to develop and test.** Test a plugin by calling it directly from your shell:
```bash
echo '{"query": "test"}' | ./my-plugin invoke
```

**Composable with Unix.** Plugins are just programs. You can pipe, redirect, time, strace — anything you can do to a process.

**Community ecosystem.** Anyone can publish `loom-*` npm packages, PyPI packages, or single-file scripts. The convention is the contract.

**Local and auditable.** Plugins run locally, as your user. No network calls to a plugin registry at runtime. No code you haven't reviewed running in your agent.

### Tricky

**Process spawn overhead.** Each tool call spawns a new process. For high-frequency tools (e.g., a tool called 100 times per task), this adds latency. Mitigation:
- Long-running plugins can optionally implement a daemon mode: the runtime sends a `daemon` command, and the plugin stays alive listening on a Unix socket. The runtime then uses the socket for subsequent calls, avoiding the spawn cost.
- This is optional — the simple subprocess model works for most tools.

**No tool versioning.** If a plugin changes its schema, agents using a cached schema see stale data until the cache invalidates. We rely on mtime-based invalidation for now. A future `version` field in the describe output will let agents detect incompatible changes.

**Security boundary.** Plugins run with the user's full permissions. A malicious plugin can do anything. This is consistent with the local-first model (the user controls what's installed) but should be documented prominently. Future work: optional sandbox via seccomp/Landlock.

**Describe caching.** The runtime caches tool schemas in memory for the lifetime of the agent process. This means a plugin update mid-session won't be reflected until the agent restarts. Acceptable for now.

## Plugin Examples (Sketches)

### Minimal bash plugin

```bash
#!/usr/bin/env bash
# loom-echo — echoes input back as a tool result

case "$1" in
  describe)
    echo '{"name":"echo","description":"Echo input back","input_schema":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}}'
    ;;
  invoke)
    INPUT=$(cat)
    MESSAGE=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['message'])")
    echo "{\"status\":\"ok\",\"result\":\"$MESSAGE\"}"
    ;;
  *)
    echo "Usage: loom-echo [describe|invoke]" >&2
    exit 1
    ;;
esac
```

### Python plugin with dependencies

```python
#!/usr/bin/env python3
# loom-search — web search using DuckDuckGo

import sys, json, subprocess

SCHEMA = {
    "name": "search",
    "description": "Search the web",
    "input_schema": {
        "type": "object",
        "properties": {"query": {"type": "string"}},
        "required": ["query"]
    }
}

def invoke(inp):
    # ... search implementation ...
    return {"status": "ok", "result": results}

cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
if cmd == "describe":
    print(json.dumps(SCHEMA))
elif cmd == "invoke":
    inp = json.loads(sys.stdin.read())
    print(json.dumps(invoke(inp)))
```

## Alternatives Considered

### Plugin SDK with registration

Require plugins to import a loom library and call `loom.register_tool(...)`. Rejected: creates language lock-in and SDK dependency. The executable protocol is universal.

### LangChain/LlamaIndex tool format

Use an existing tool format. Rejected: requires runtime dependency on their framework, and their formats are not stable. The Anthropic tool definition format is what we send to the API anyway — use that directly.

### WASM plugins

Compile plugins to WebAssembly for sandboxing and portability. Interesting future direction but over-engineered for v1. The subprocess model is simpler and works today.

### JSON-RPC over Unix sockets

More efficient than subprocess per call. Rejected for the base case — too complex for a simple tool. Reserved for the optional daemon mode for performance-critical tools.

## References

- Anthropic tool use API — https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- [Git's subcommand model](https://schacon.github.io/gitbook/1_the_git_object_model.html) — executables named `git-*` discovered on PATH
- [Kubectl plugins](https://kubernetes.io/docs/tasks/extend-kubectl/kubectl-plugins/) — same pattern
- [jq](https://stedolan.github.io/jq/) and [fx](https://fx.wtf/) — inspiration for stdin/stdout JSON tools
