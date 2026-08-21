# Contributing

Use Node.js 22 and install with `npm ci`.

This repository is a capability built on
[`@agent-tool-platform/runtime`](https://www.npmjs.com/package/@agent-tool-platform/runtime). The
rule that decides where code belongs is: **AST owns AST behaviour, the platform owns
agent-tool-server behaviour.** Do not add a second HTTP application, MCP stack, tool registry,
authenticator, rate limiter, OpenAPI generator, or lifecycle manager here — compose the platform's.
Conversely, do not push analysable extensions, `node_modules` policy, AST limits, or projection rules
into the platform.

Declare every tool in `src/tools/definitions.ts` with platform routing metadata, and register it
through `astSummarizerCapability`. The server is read-only: do not add a tool that writes, executes,
installs, clones, or generates source.

Every new analysis path needs a limit, honest truncation reporting, and a cancellation check between
work units. Tests must cover validation, safe errors, workspace confinement, limits, and the
generated transport surfaces. Platform contracts are covered by the
`@agent-tool-platform/testkit` suites in `tests/conformance/`; add domain coverage under
`tests/unit/ast/` and `tests/integration/` rather than re-testing platform behaviour.

Before opening a pull request, run the complete validation list in `README.md`. Never commit `.env`
files, deployment outputs, credentials, tenant/subscription identifiers, generated secrets, copied
repositories, or large fixtures; tests build their fixtures in a temporary directory instead.
