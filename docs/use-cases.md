# Use cases

This document defines what this server is for, what it is not for, and which deployment shapes are
supported. Anything we build should serve a use case listed here.

## The rule that determines everything

**The server reads source files from its own filesystem. A caller only ever sends a path string.**

Both tools accept `path` (plus limits and options). Neither accepts file content:

| Tool                   | Accepted input                            |
| ---------------------- | ----------------------------------------- |
| `get_file_skeleton`    | `path`, `includePrivateMembers`, `limits` |
| `get_dependency_graph` | `path`, `maxDepth`, `limits`              |

There is no upload path and no mechanism to stream a caller's files to the server. Therefore a
server instance can only analyse code that already exists on the machine running it. Every
supported and unsupported scenario below follows from that one fact.

## Scenario A — Local stdio (primary, recommended)

An MCP client such as VS Code launches the server as a child process. It reads the live workspace
directly.

```
┌─ Your machine ────────────────────────────────────────┐
│                                                       │
│   VS Code + agent                                     │
│         │                                             │
│         │  launches as a child process                │
│         │  (stdin/stdout — no network, no credential) │
│         ▼                                             │
│   ast-summarizer  ──reads──►  /path/to/your/project   │
│                               ▲                       │
│                               └─ live files, current  │
└───────────────────────────────────────────────────────┘
```

- **Freshness:** always current; a saved edit is visible to the next call.
- **Setup:** one `.vscode/mcp.json` entry. No credential, no infrastructure.
- **Privacy:** source never leaves the machine and never crosses a network boundary.
- **Scope:** one workspace root per process. For a multi-root workspace, register one scoped
  instance per root.

This is the case the product is designed around.

## Scenario B — Hosted HTTP against a source copy (supported, narrow)

An agent running somewhere else calls the server over authenticated HTTPS. The server analyses a
read-only copy of source that was placed on its filesystem ahead of time.

```
   Agent (anywhere)                Azure Container App
  ┌──────────────────┐            ┌──────────────────────────┐
  │ sends            │  HTTPS +   │  ast-summarizer          │
  │ {path:"src/a.ts"}├───────────►│        │                 │
  │                  │  API key   │        │ reads           │
  │ ◄─ declarations  │            │        ▼                 │
  └──────────────────┘            │  /workspace  (read-only) │
                                  └────────▲─────────────────┘
                                           │
                                  ┌────────┴─────────┐
                                  │ Azure Files share│
                                  │ uploaded snapshot│
                                  └──────────────────┘
```

- **Freshness:** a snapshot. It is stale from the moment the source moves on, until re-uploaded.
- **Setup:** container image, API key in Key Vault, storage share, read-only mount.
- **Not ready by default:** without `AST_WORKSPACE_ROOT` pointing at a usable root, `/ready`
  returns 503 and every tool call returns `not_ready`. The server refuses to pretend it can answer.
- **Fits when:** the codebase is fixed or slow-moving, and the caller cannot run a local process —
  for example a CI job or a hosted agent inspecting a released version.
- **Does not fit:** day-to-day development against code you are actively editing.

## Scenario C — Co-located automation (supported)

A CI job or container that already has the repository checked out runs the server against that
checkout, over stdio or on localhost.

```
┌─ CI runner / container ────────────────────────────┐
│   checked-out repo  ◄──reads──  ast-summarizer     │
│                                        ▲           │
│                                   job / agent      │
└────────────────────────────────────────────────────┘
```

Freshness is exact, because the server and the source share a filesystem. This is the hosted
scenario's freshness problem solved by co-location.

## Explicitly not supported

### VS Code pointed at a remote instance

```
   VS Code on your laptop  ──►  remote server
   "summarize src/main.ts"          │
                                    ▼
                     looks on ITS OWN disk for src/main.ts
                     → answers from a stale copy, or fails
```

Local edits are invisible to a remote server. It would answer from someone else's snapshot or
return `not_found`. This is worse than unavailable, because the answer looks authoritative.

This is a deliberate exclusion, not a gap to fill later. Streaming a workspace on every call would
be slow, would put source on the network, and would destroy the privacy property that makes
Scenario A safe.

### Other exclusions

| Not supported                                      | Why                                                         |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Analysing more than one workspace root per process | Ambiguous path resolution; run one scoped instance per root |
| Reading installed packages (`node_modules`)        | Out of scope; packages are reported as external, not read   |
| Runtime behaviour, values, side effects            | Nothing is ever executed or evaluated                       |
| Writing, generating, installing, cloning, building | The server is read-only by design                           |
| A complete build or call graph                     | Only local source relationships from one entry file         |
| Returning implementations                          | Bodies are removed; use a file-reading tool for those       |

## Choosing a scenario

| Question                                         | Use            |
| ------------------------------------------------ | -------------- |
| Developing in VS Code on your own machine?       | A (stdio)      |
| Job already has the code checked out?            | C (co-located) |
| Caller is remote and the code is fixed/released? | B (hosted)     |
| Caller is remote and the code is being edited?   | Not supported  |

## Implications for future work

- Local stdio ergonomics carry the most value per unit of effort.
- Hosted work should target Scenario B's real constraint — snapshot freshness and the operational
  cost of keeping a copy current — rather than adding capability the model does not support.
- Any proposal that implies a remote server reading a caller's local files contradicts the rule at
  the top of this document and should be rejected or redesigned.
