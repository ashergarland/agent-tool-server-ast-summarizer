# Contributing

Use Node.js 22 and install with `npm ci`.

Keep provider logic out of transports, keep compiler and AST imports out of `src/platform/`, and
register every exposed tool in the shared typed registry. The server is read-only: do not add a tool
that writes, executes, installs, clones, or generates source.

Every new analysis path needs a limit, honest truncation reporting, and a cancellation check between
work units. Tests must cover validation, safe errors, workspace confinement, limits, and the
generated transport surfaces.

Before opening a pull request, run the complete validation list in `README.md`. Never commit `.env`
files, deployment outputs, credentials, tenant/subscription identifiers, generated secrets, copied
repositories, or large fixtures; tests build their fixtures in a temporary directory instead.
