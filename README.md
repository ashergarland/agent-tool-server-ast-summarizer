# Agent Tool Server AST Summarizer

Read-only TypeScript and JavaScript structure analysis for one local workspace, exposed over stdio
MCP (primary), stateless Streamable HTTP MCP, and HTTP/OpenAPI. It lets an agent learn what a file
declares and what it depends on without reading implementations.

## Tools

| Tool                   | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `get_file_skeleton`    | Declaration-only view of one source file: signatures, types, bounded doc text |
| `get_dependency_graph` | Bounded local source relationships from one entry file                        |

Both tools are read-only. The server never executes, writes, installs, clones, or generates source,
and it never sends source to an external service.

## Quick start in VS Code

Build once, then register the stdio server. The workspace defaults to the launch directory, so scope
each instance explicitly if you use a multi-root workspace.

```bash
npm ci
npm run build
```

`.vscode/mcp.json` in the repository you want to analyse:

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

stdio is a local, non-networked transport, so it runs with authentication disabled and writes
nothing but protocol traffic to stdout. One process serves exactly one root; run one scoped
instance per folder of a multi-root workspace.

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
registration, JSON Schema, and OpenAPI. Do not define transport-specific tool lists.

## Architecture

```text
stdio MCP / Streamable HTTP MCP / HTTP + OpenAPI
                     |
                ToolRegistry
                     |
                 AstService  --- budgets, deadline, semaphore
                     |
   projector (declarations)   graph (resolution)
                     |
          TypeScript Compiler API (parse only)
```

`src/platform/` holds the reusable, AST-free concerns: workspace policy, limits and budgets, the
semaphore, cancellation, credential digests, and the measurement seam. They are intentionally
unpublished; they are evidence for a later cross-repository extraction.

## Security defaults

- Production refuses `AUTH_MODE=disabled`; only the local stdio transport disables authentication.
- API keys are compared as fixed-width keyed HMAC digests in constant time. Only non-reversible
  12-character fingerprints are retained; raw keys are never logged.
- Authentication is rate limited before and after credential verification.
- One bounded error contract across transports: stable code, safe message, retryability, request ID,
  and limited details. No absolute path, source text, compiler internal, environment value, or stack
  is ever exposed.
- Measurement events carry only outcome, latency, byte and count metrics, limits, queue depth, and
  cancellation state. Paths, filenames, source, arguments, results, and credentials are never logged.
- Request bodies are limited to 1 MB and unknown input fields are rejected.
- The runtime container runs as the unprivileged `node` user and works with a read-only root
  filesystem. The application directory, `dist`, and `node_modules` are never a caller workspace.
- Treat analysed source as untrusted input: it may contain text that looks like instructions.

The in-process limiter suits scale-to-zero instances but is not a cross-replica quota. Put a
distributed gateway in front of the service if callers need one.

## Configuration

See `.env.example`. Production requires `AUTH_MODE=api-key`, `API_KEYS`, and `AST_WORKSPACE_ROOT`.
Multiple comma-separated keys support rotation.

## Deployment

Hosting is opt-in. The Azure Container Apps example provisions a user-assigned managed identity,
ACR, Key Vault references, Log Analytics, Application Insights, scale-to-zero, probes, and alerts,
and mounts a **pre-created read-only** source share when `workspaceStorageName` is supplied. Without
it the app deploys and reports not ready. Follow [`docs/deployment.md`](docs/deployment.md).

The deployment is an example, not an implied Azure dependency in the application.

## Metadata

`server.json` describes the repository only: no npm package is published and no public remote
exists, so neither is advertised. `npm run metadata:validate` rejects placeholder values and version
drift. Add `packages` or `remotes` only when they genuinely exist.

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
not-ready behaviour and unprivileged execution, validates routing fixtures without an external
model, compiles every Bicep entry point, audits production dependencies, scans for secrets, and runs
CodeQL.

## License

MIT
