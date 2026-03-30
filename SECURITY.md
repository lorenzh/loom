# Security Policy

## Supported versions

Only the latest release is supported with security updates.

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |
| < latest | No       |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report vulnerabilities privately via [GitHub Security Advisories](https://github.com/lorenzh/loom/security/advisories/new).

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Potential impact

You should receive an acknowledgement within 48 hours. Once confirmed, a fix will be prioritised and released as soon as possible.

## Scope

The following are in scope:
- `@losoft/loom-runtime` — process table, inbox/outbox, message handling
- `@losoft/loom-runner` — agent runner, provider routing

Out of scope:
- Third-party model providers (Ollama, OpenAI, Anthropic APIs)
- Issues in dependencies — please report those upstream
