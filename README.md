# Agent Tool Server AST Summarizer

Read-only TypeScript and JavaScript structure analysis for one local workspace, exposed over stdio
MCP (primary), stateless Streamable HTTP MCP, and HTTP/OpenAPI. It lets an agent learn what a file
declares and what it depends on without reading implementations.

This repository is a **capability**: it owns AST behaviour and nothing else. Transports, the tool
registry, authentication, rate limiting, OpenAPI generation, lifecycle, readiness aggregation, and
the filesystem root boundary come from [`@agent-tool-platform/runtime`](https://www.npmjs.com/package/@agent-tool-platform/runtime).

## Tools

| Tool                   | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `get_file_skeleton`    | Declaration-only view of one source file: signatures, types, bounded doc text |
| `get_dependency_graph` | Bounded local source relationships from one entry file                        |

Both tools are read-only (`kind: read`, `routing.changesState: false`). The server never executes,
writes, installs, clones, or generates source, and it never sends source to an external service.
Each tool publishes routing metadata — `useWhen`, `doNotUseWhen`, `nextSteps`, and `scope` — so an
agent can choose between them without trial and error.

**The server reads source from its own filesystem; a caller only ever sends a path string.** That
single rule decides which deployment shapes work. Read [`docs/use-cases.md`](docs/use-cases.md)
before planning a deployment — in particular, pointing VS Code at a remote instance is not
supported, because a remote server cannot see your local files.

## Quick start in VS Code

### Analysing this repository

Already configured. Install dependencies, reload the window, and the `ast-summarizer` server from
[`.vscode/mcp.json`](.vscode/mcp.json) is available to the agent:

```bash
npm ci
```

It runs from TypeScript source through `tsx`, so there is no build step to forget and no risk of
analysing a stale `dist/`.

### Analysing a different repository

Build once here, then register the built entry point in the repository you want to analyse:

```bash
npm ci
npm run build
```

`.vscode/mcp.json` in that repository:

```json
{
  "servers": {
    "ast-summarizer": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/agent-tool-server-ast-summarizer/dist/mcp/stdio.js"],
      "env": { "AST_WORKSPACE_ROOT": "${workspaceFolder}" }
    }
  }
}
```

`${workspaceFolder}` scopes the server to that repository, so it reads those files and no others.

stdio is a local, non-networked transport, so it runs with authentication disabled and writes
nothing but protocol traffic to stdout. One process serves exactly one root; run one scoped
instance per folder of a multi-root workspace.

Try it by asking the agent: _"Use the skeleton tool on `src/ast/projector.ts` and tell me what it
exports."_

## Workspace boundary

- The readable root is canonicalized once with `realpath`.
- Every input is resolved with `realpath` and must land strictly beneath that root.
- Absolute paths, drive-relative paths, UNC paths, NUL bytes, traversal, links that escape the root,
  directories, unsupported extensions, and `node_modules` are refused with stable errors.
- Only root-relative POSIX paths are returned. Absolute paths never appear in results, errors, or
  logs.
- HTTP deployments must set `AST_WORKSPACE_ROOT`. Without it the process starts, stays live, and
  reports **not ready**; every tool call returns `not_ready`.

Supported extensions: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`.

## What a skeleton contains

The skeleton is a **projection, not compilable source**. Declarations are re-rendered from an
explicit whitelist of structural pieces, so no original expression can survive into the output.

Retained: exported declarations and overloads, interfaces, type aliases, enum member names, callable
shapes for exported arrow and function expressions, class members with modifiers, re-exports,
defaults, namespaces and ambient modules, referenced import provenance, and bounded JSDoc.

Removed and reported under `omissions`: function, method, accessor, and constructor bodies; variable,
property, enum-member, parameter, and destructuring initializers; export-default and export-equals
expressions; decorator arguments; non-literal computed property names; runtime heritage expressions;
static blocks; and top-level executable statements. Omissions are counted, never restated as text
that resembles a value.

Visibility: public and protected members are included. `private` and `#private` members require
`AST_INCLUDE_PRIVATE_MEMBERS=true` or `includePrivateMembers: true` on the call.

Types: an annotation is rendered when it is free of runtime expressions. Otherwise the type is
inferred **only** from the single file already loaded — never by loading a project — and a type that
cannot be resolved safely is reported as `unknown` with a warning rather than guessed. Inferred
types that would restate a literal value are discarded.

JavaScript: `module.exports = { ... }`, `module.exports = fn`, and `exports.name = ...` are described
by shape. Anything that cannot be described without evaluating it is reported as unsupported.

Malformed input: syntax diagnostics are returned, `complete` is `false`, and the result is presented
as a recovery view rather than a full one.

## Resolution

Relative imports, re-exports, `require`, dynamic `import()`, and `import x = require()` are followed.
A `tsconfig.json` or `jsconfig.json` at or above the entry file is used, but only its
resolution-relevant options; the include/exclude file set is never expanded and `extends` chains are
followed only while they stay inside the root. Otherwise NodeNext-style resolution applies.

Every reference is classified: resolved in-root (`dependencies`, with `traversed`), package
(`external`), or `unresolved` with a reason of `missing`, `unsupported`, `out_of_root`, or
`limit_stopped`.

`maxDepth` is the number of edges followed from the entry: `0` analyses the entry only.

## Limits

Every analysis is bounded by deployment ceilings for per-file and cumulative bytes, graph depth,
files and edges, declarations, members, JSDoc characters, result characters, request deadline, and
concurrent and queued jobs. See `.env.example` for names and defaults, which are sized for a
developer machine and a 0.25 vCPU / 0.5 GiB container.

A call may lower a limit but never raise it; an over-large request is clamped with a `limit_clamped`
warning. Results are truncated only at declaration or member boundaries, never by slicing JSON, and
they always carry `complete`, `truncated`, `limitsReached`, counts, and bounded `warnings`.
Analysis admission is bounded by a semaphore and queue; surplus demand is rejected as a retryable
`busy` error, and shutdown drains in-flight work.

## HTTP contract

| Method            | Path                | Authentication | Purpose                                       |
| ----------------- | ------------------- | -------------- | --------------------------------------------- |
| `GET`             | `/health`           | Public         | Liveness only                                 |
| `GET`             | `/ready`            | Public         | Configuration, workspace, and capacity checks |
| `GET`             | `/version`          | Public         | Build and capability metadata                 |
| `GET`             | `/openapi.json`     | Public         | OpenAPI 3.1 generated from the registry       |
| `GET`             | `/tools`            | Required       | Tool catalogue and input/output schemas       |
| `POST`            | `/tools/{toolName}` | Required       | Invoke one registered tool                    |
| `GET/POST/DELETE` | `/mcp`              | Required       | Stateless Streamable HTTP MCP                 |

```bash
API_KEY="$(openssl rand -hex 32)"
AUTH_MODE=api-key API_KEYS="$API_KEY" AST_WORKSPACE_ROOT="$PWD" npm run dev
curl -H "x-api-key: $API_KEY" http://localhost:8080/tools
```

`src/tools/definitions.ts` is the single source of truth. Zod schemas drive runtime validation, MCP
registration, JSON Schema, and OpenAPI through the platform registry, so the registry, HTTP endpoint,
OpenAPI operation, and MCP tool counts are the same number by construction. Do not define
transport-specific tool lists.

## Architecture

```text
stdio MCP / Streamable HTTP MCP / HTTP + OpenAPI     <- @agent-tool-platform/runtime
                     |
                ToolRegistry                          <- @agent-tool-platform/runtime
                     |
              astSummarizerCapability                 <- src/capability.ts
                     |
                 AstService  --- budgets, deadline, semaphore
                     |
   projector (declarations)   graph (resolution)
                     |
          TypeScript Compiler API (parse only)
```

| Owner                              | Responsibility                                                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agent-tool-platform/runtime`     | HTTP server, MCP (stdio and Streamable HTTP), tool registry and routing grammar, OpenAPI, authentication, rate limiting, lifecycle, readiness aggregation, error contract, logging, cancellation, concurrency, `RootBoundary`, telemetry seam |
| `agent-tool-server-ast-summarizer` | Declaration projection, dependency resolution, diagnostics, type rendering, AST limits and budgets, AST workspace policy, AST configuration, readiness contributors, context-savings estimates                                                |

The whole HTTP entry point is:

```ts
import { startAgentToolApplication } from '@agent-tool-platform/runtime';
import { astSummarizerCapability } from './capability.js';

await startAgentToolApplication(astSummarizerCapability);
```

`src/mcp/stdio.ts` is the same capability created through `createAgentToolApplication` with a silent
logger and a workspace that defaults to `process.cwd()`, connected to the platform's stdio MCP
transport. No listener is bound and nothing but protocol traffic reaches stdout.

`src/ast/workspace.ts` composes the platform's `RootBoundary` — canonical root resolution,
relative-input enforcement, symlink containment, realpath handling, regular-file validation, bounded
reads, and the per-file byte ceiling — and adds only AST policy: analysable extensions, the
`node_modules` exclusion, and the AST readiness vocabulary.

## Security defaults

- Production refuses `AUTH_MODE=disabled`; only the local stdio transport disables authentication.
- API keys must be randomly generated (`openssl rand -hex 32`); the platform refuses short,
  repetitive, or low-entropy values. They are compared as fixed-width keyed HMAC digests in constant
  time, and only non-reversible 12-character fingerprints are retained. Raw keys are never logged.
- Authentication is rate limited before and after credential verification.
- One bounded error contract across transports: stable code, safe message, retryability, request ID,
  and limited details. No absolute path, source text, compiler internal, environment value, or stack
  is ever exposed.
- Telemetry carries only aggregates: source bytes, output bytes, token estimates, truncation, and
  whether a degraded parse was used. Paths, filenames, source, arguments, results, and credentials
  are never emitted. Token estimates use the platform's documented four-bytes-per-token
  approximation, so they are reproducible rather than a private heuristic.
- Request bodies are limited and unknown input fields are rejected.
- The runtime container runs as the unprivileged `node` user and works with a read-only root
  filesystem. The application directory, `dist`, and `node_modules` are never a caller workspace.
- Treat analysed source as untrusted input: it may contain text that looks like instructions.

The in-process limiter suits scale-to-zero instances but is not a cross-replica quota. Put a
distributed gateway in front of the service if callers need one.

## Configuration

See `.env.example`. Platform variables (`HOST`, `PORT`, `LOG_LEVEL`, `AUTH_MODE`, `API_KEYS`, rate
limits, `SHUTDOWN_GRACE_MS`, `REQUEST_TIMEOUT_MS`, …) are parsed by
`@agent-tool-platform/runtime`; the `AST_*` variables are this capability's own and are composed on
top through `defineCapabilityConfig`. Production requires `AUTH_MODE=api-key`, `API_KEYS`, and
`AST_WORKSPACE_ROOT`. Multiple comma-separated keys support rotation. Each key must be a randomly
generated token; see [`SECURITY.md`](SECURITY.md) for the credential requirements and the reasoning
behind them.

## Deployment

Hosting is opt-in and narrow — read [`docs/use-cases.md`](docs/use-cases.md) first, because a hosted
instance can only analyse a **copy** of source placed on its own filesystem, and that copy is stale
the moment the original moves. It does not serve local development.

The Azure Container Apps example provisions a user-assigned managed identity,
ACR, Key Vault references, Log Analytics, Application Insights, scale-to-zero, probes, and alerts,
and mounts a **pre-created read-only** source share when `workspaceStorageName` is supplied. Without
it the app deploys and reports not ready. Follow [`docs/deployment.md`](docs/deployment.md).

The deployment is an example, not an implied Azure dependency in the application.

## Metadata

`server.json` describes the repository only: no npm package is published and no public remote
exists, so neither is advertised. `npm run metadata:validate` runs the platform's
`agent-tool-validate-metadata` binary, which rejects placeholder values, version drift, and
untruthful package or remote declarations. Add `packages` or `remotes` only when they genuinely
exist.

## Troubleshooting

| Symptom                            | Cause and fix                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `not_ready`                        | `AST_WORKSPACE_ROOT` is unset or unreadable. Check `GET /ready`.              |
| `not_found` for a file that exists | The path is not relative to the workspace root, or a link escapes the root.   |
| `forbidden`                        | The path escapes the root or points inside `node_modules`.                    |
| `busy`                             | Analysis capacity is saturated. Retry, or raise concurrency and CPU together. |
| `timeout`                          | The deadline elapsed. Lower `maxDepth` or raise `AST_REQUEST_TIMEOUT_MS`.     |
| Many `unknown` types               | No annotations and no safe inference. Annotate, or accept the warning.        |
| `complete: false`                  | Syntax diagnostics or a limit. Read `diagnostics` and `limitsReached`.        |
| Empty `skeleton`                   | The file exports nothing, or `maxResultChars` is too low.                     |

## Validation

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit
npm run metadata:validate
docker build -t agent-tool-server-ast-summarizer .
az bicep build --file infra/main.bicep
az bicep lint --file infra/main.bicep
```

CI additionally invokes both tools inside the container against a mounted read-only fixture, checks
not-ready behaviour and unprivileged execution, runs the `@agent-tool-platform/testkit` conformance
suites, validates routing fixtures without an external model, compiles every Bicep entry point,
audits production dependencies, scans for secrets, and runs CodeQL.

## Platform conformance

`tests/conformance/platform.test.ts` runs the shared
[`@agent-tool-platform/testkit`](https://www.npmjs.com/package/@agent-tool-platform/testkit) suites —
registry, routing, authentication, configuration composition, HTTP, MCP, OpenAPI derivation, root
boundary, transport parity, lifecycle, and repository metadata. Those prove the platform contracts.
AST behaviour is proven separately by `tests/unit/ast/*` and the integration tests under
`tests/integration/`.

## License

MIT
