# Security

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not
open a public issue for an undisclosed vulnerability.

## Threat model

The server reads source files and returns a reduced view of them. Its security posture rests on one
canonical workspace boundary, read-only behaviour, and bounded work.

| Threat                                          | Control                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading files outside the intended workspace    | The root is canonicalized once with `realpath`; every input is resolved with `realpath` and must land strictly beneath it.                                |
| Traversal, absolute, UNC, or NUL-byte paths     | Rejected before any filesystem access.                                                                                                                    |
| Symbolic links that escape the root             | Containment is checked after link resolution; the read then uses `O_NOFOLLOW` where the platform supports it.                                             |
| Time-of-check/time-of-use races                 | Reads go through a single descriptor whose size and file type are re-checked after opening.                                                               |
| Package internals treated as workspace source   | `node_modules` inputs are refused and package specifiers are reported as external without being read.                                                     |
| Source execution                                | Only the TypeScript parser and a single-file checker are used. No source is evaluated, transpiled to run, built, installed, or cloned.                    |
| Implementation leaking through a "skeleton"     | Declarations are re-rendered from a structural whitelist; bodies, initializers, decorator arguments, and heritage expressions cannot survive.             |
| Secrets embedded in analysed source             | Every initializer and expression is dropped, and inferred types that would restate a literal are discarded.                                               |
| Prompt injection from analysed source           | Guidance instructs agents to treat source text as untrusted data, never as instructions.                                                                  |
| Resource exhaustion                             | Per-file, cumulative byte, depth, file, edge, declaration, member, documentation, result-size, and deadline ceilings, plus a bounded semaphore and queue. |
| Credential disclosure through comparison timing | Presented secrets are reduced to fixed-width keyed HMAC digests compared in constant time.                                                                |
| Offline cracking of a credential digest         | Digests are never stored or transmitted, the HMAC key is fresh random bytes per process, and configuration refuses low-entropy keys.                      |
| Credential disclosure through logs              | Only non-reversible truncated fingerprints are retained; authorization and API-key headers are redacted.                                                  |
| Information disclosure through errors           | One bounded error contract with stable codes and safe messages; no absolute path, source text, compiler internal, or stack is returned.                   |
| Serving traffic without a real workspace        | `/ready` is separate from `/health` and fails until a canonical readable root and analysis capacity exist.                                                |

Out of scope: protecting a caller from source they are already authorized to read, cross-replica
quotas, and the correctness of a workspace an operator chooses to mount.

## Credential handling

`API_KEYS` holds machine tokens, not user-chosen passwords, and they must be generated randomly:

```bash
openssl rand -hex 32
```

Configuration refuses a key that is shorter than 32 characters, repeats a short pattern, or falls
below roughly 96 bits of estimated entropy, so a wordlist- or pattern-reachable key cannot be
deployed.

Verification uses HMAC-SHA256 keyed with fresh random bytes per process, compared in constant time.
A deliberately slow KDF such as scrypt or Argon2 is **not** used here, and that is intentional:

- No digest is stored, transmitted, or written to disk. It exists only in memory for the duration of
  one comparison, so there is no artefact to attack offline — the threat a slow KDF exists to raise
  the cost of.
- The HMAC key is per-process and random, so a digest cannot be recomputed outside the running
  process even with the credential.
- The input is a verified high-entropy token, so brute force is infeasible regardless of hash speed.
- Running a slow KDF on every request would give an unauthenticated caller a cheap CPU-exhaustion
  lever against a container sized for a fraction of a core.

Static analysis reports this as `js/insufficient-password-hash` because it treats any credential
flowing into a fast hash as a stored password. That premise does not hold here; the two alerts are
dismissed as false positives with this rationale recorded. If credential digests ever become
persisted, or if operator-chosen passphrases are ever accepted, this decision must be revisited and
a slow KDF adopted.

## Deployment requirements

Enable authentication, store credentials in a secret manager, mount source read-only, use
least-privilege identities, size analysis concurrency to the available CPU, and review dependency
and container findings before release.
