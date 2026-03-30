# ADR-006: Plugin and extension model

**Status:** Draft
**Date:** 2026-03-25

## Context

loom's core runtime handles the essentials: filesystem layout, inbox watching,
supervisor, CLI. But users need to extend it:

- Custom triggers (watch a price feed, respond to a webhook, react to a git push)
- Custom tools (give agents the ability to call APIs, write files, run commands)
- Custom transports (send messages via Telegram, Slack, email — not just the filesystem)
- Custom model providers (a model not supported by the built-in router)
- Lifecycle hooks (run code before/after an agent processes a message)

The question is: what is the right extension point?

Options:
1. **Plugins as npm packages** — publish `loom-plugin-*` packages
2. **Plugins as local scripts** — shell scripts or Node scripts in a `plugins/` dir
3. **Plugins as in-process hooks** — TypeScript hooks loaded from `loom.config.ts`
4. **Plugins as sidecar processes** — separate processes that communicate via the filesystem

## Decision

Plugins are **sidecar processes** that communicate with the loom runtime via the
filesystem — the same way agents communicate with each other. This is the Unix
philosophy applied to extensions: a plugin is just another process.

For convenience, a small in-process hook system handles the common case of intercepting
agent events without writing a full sidecar.

### 1. Sidecar plugins (primary model)

A sidecar plugin is any process that:
- Reads from and writes to `$LOOM_HOME/` using the documented filesystem layout
- Optionally reads a plugin config section from `loom.yml`

Example: a Telegram notification plugin

```
# Runs as a separate process, watching for outbox messages to forward
loom-plugin-telegram --token $TOKEN --chat-id $CHAT_ID --watch notify-agent
```

The plugin is not managed by the loom supervisor — it is started independently,
by systemd, or alongside `loom up` via a shell wrapper. It has no special privileges.

A plugin that reads agent outboxes is just a script:

```sh
#!/bin/sh
# poll outbox every 5s, send any new messages to Telegram
while true; do
  for f in ~/.loom/agents/notify/outbox/*.msg; do
    [ -f "$f" ] || continue
    body=$(jq -r .body "$f")
    curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
      -d chat_id="$CHAT_ID" -d text="$body"
    mv "$f" "${f%.msg}.sent"
  done
  sleep 5
done
```

This is not exotic — it is the Unix way. Any language, any tool, no SDK required.

### 2. In-process hooks (convenience model)

For plugins that need tight integration with the runtime (e.g., custom model providers,
custom tools, lifecycle interceptors), `loom.config.ts` supports in-process hooks:

```typescript
// loom.config.ts
import type { LoomConfig } from 'loom'

export default {
  // Add custom tools available to all agents
  tools: [
    {
      name: 'web_search',
      description: 'Search the web for a query',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      },
      handler: async ({ query }) => {
        // ... call your search API
        return { results: [...] }
      }
    }
  ],

  // Lifecycle hooks
  hooks: {
    // Called before each agent processes a message
    beforeMessage: async ({ agent, message }) => {
      console.log(`${agent.name} received: ${message.body}`)
    },

    // Called after each agent responds
    afterMessage: async ({ agent, message, response }) => {
      // Could log to external system, update a dashboard, etc.
    },

    // Called when an agent crashes
    onCrash: async ({ agent, exitCode }) => {
      // Could send an alert
    }
  },

  // Custom model providers
  providers: [
    {
      name: 'my-local-llm',
      match: (model: string) => model.startsWith('local/'),
      create: (model: string) => new MyLocalLLMClient(model)
    }
  ]
} satisfies LoomConfig
```

`loom.config.ts` is loaded by the supervisor at startup. If it fails to load,
the supervisor logs the error and continues with default configuration.

### 3. Custom triggers

Triggers that cannot be expressed as cron entries can be implemented as sidecar
processes that send messages to an agent's inbox:

```typescript
// plugins/price-watcher.ts — watches BTC price, sends alert if threshold crossed
import { sendMessage } from 'loom/client'

const threshold = 100000
let lastPrice = 0

setInterval(async () => {
  const price = await fetchBTCPrice()
  if (price > threshold && lastPrice <= threshold) {
    await sendMessage('portfolio-agent', {
      body: `BTC crossed $${threshold.toLocaleString()}. Current: $${price.toLocaleString()}`
    })
  }
  lastPrice = price
}, 60_000)
```

`loom/client` is a thin package that knows how to write message files to the
correct inbox path. It does not require the loom runtime to be running — it just
writes files.

### Plugin discovery (future)

v1 has no automatic plugin discovery. Plugins are started explicitly by the operator.

A future `plugins:` section in `loom.yml` may support declaring plugins that should
be started alongside the weave:

```yaml
# Future — not in v1
plugins:
  - name: telegram
    package: loom-plugin-telegram
    env:
      TELEGRAM_BOT_TOKEN: "${TELEGRAM_BOT_TOKEN}"
```

## Consequences

**Good:**
- Sidecar plugins have zero coupling to the loom runtime. They can be written in any
  language, deployed independently, and updated without touching the core.
- The filesystem is the interface. A plugin written today will still work if loom's
  internals change, as long as the filesystem layout (ADR-002) is stable.
- In-process hooks cover the tight-integration cases (custom tools, model providers)
  without requiring IPC protocols.
- `loom/client` lets any script send messages to an agent with minimal code.

**Bad:**
- Sidecar plugins must be started and managed separately. There is no `loom up`-style
  lifecycle for plugins in v1. Operators must use systemd, a shell wrapper, or manual
  management.
- In-process hooks run in the supervisor process. A badly written hook can crash the
  supervisor. Mitigated by wrapping all hook calls in try/catch.
- No plugin registry or discovery mechanism in v1. Finding community plugins requires
  searching npm for `loom-plugin-*`.

## Alternatives considered

**Plugins as npm packages loaded by CLI:** Would require the loom CLI to dynamically
load npm packages, which creates security and dependency hell. Rejected.

**gRPC/message-bus plugin protocol:** A formal IPC protocol between plugins and runtime.
Maximum capability. But adds complexity and coupling — plugins now depend on the
protocol version. Rejected in favour of filesystem communication.

**No plugin system:** Just document the filesystem layout and let people build their
own tooling. Tempting. But `loom/client` and the lifecycle hooks are genuinely
useful and worth the small surface area they add.
