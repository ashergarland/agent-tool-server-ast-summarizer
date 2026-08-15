# Azure Container Apps deployment example

This example is replaceable hosting scaffolding. It does not add Azure product logic to the tool
server.

## Prerequisites

- Azure CLI with the Bicep CLI installed
- Docker
- permission to create subscription deployments, a resource group, role assignments, and the
  included resources
- a signed-in human user that can be granted Key Vault Secrets Officer during bootstrap
- a selected subscription (`az account set --subscription ...`)

Do not place subscription IDs, tenant IDs, credentials, or generated deployment names in tracked
files.

## Safe two-pass provisioning

```bash
./scripts/bootstrap/provision.sh dev eastus
```

The script:

1. validates and deploys shared resources with `deployApp=false`;
2. prompts for or generates an API key and writes it directly to Key Vault;
3. signs in to the created registry, builds and pushes the image;
4. deploys again with `deployApp=true`.

The first pass prevents Container Apps from repeatedly starting with a missing Key Vault secret.
The second pass adds the app, probes, scale rules, and monitoring after its prerequisites exist.

For automation, set `API_KEY` in the job's protected secret environment and set `IMAGE_TAG` to an
immutable commit SHA. Do not use `latest` for production releases.

## Identity and secrets

The Container App uses a user-assigned managed identity to pull from ACR and read the Key Vault
secret. No registry password or API key is embedded in Bicep. Add provider-specific role
assignments in a separate module and grant only the actions required by registered tools.

The interactive bootstrap user receives Key Vault Secrets Officer so it can seed and rotate this
secret. Remove that assignment after handoff if a separate deployment identity manages rotation.

## Hosting is opt-in

This service is local-first. A hosted instance is useful only when it has an authorized, read-only
copy of the source it should analyse. Until then it deliberately starts, stays live on `/health`,
and reports **not ready** on `/ready`; every tool call returns `not_ready`.

To make a hosted instance ready:

1. create an Azure Files share containing the source to expose;
2. register it on the managed environment as **read-only** storage
   (`az containerapp env storage set ... --access-mode ReadOnly`);
3. pass its name as `workspaceStorageName`.

The template then mounts it at `workspaceMountPath` and sets `AST_WORKSPACE_ROOT`. The storage
account key stays in the environment storage definition and never enters this repository. There is
no upload path, no clone step, and no credential in the template.

If your platform cannot present a safe read-only volume, do not host the service: run it locally
over stdio instead.

## Sizing

Analysis is CPU-bound and synchronous inside the compiler, so a 0.25 vCPU replica cannot absorb
many concurrent jobs. Keep `astMaxConcurrentJobs` at or below the vCPU budget and keep
`httpConcurrentRequests` aligned with it; scaling on twenty concurrent requests would queue
expensive work behind a replica that cannot serve it. Surplus demand is rejected as a retryable
`busy` error rather than queued without bound.

Every analysis ceiling in `analysisLimits` is a deployment maximum. A caller may lower a limit for
one request but can never raise one.

## Operations

The app scales from zero and uses `/health` for liveness and `/ready` for readiness, so a replica
without a usable workspace is never sent traffic. Log Analytics and workspace-based Application
Insights are provisioned, and the `alerts` module adds restart and server-failure metric alerts.
Set `alertNotificationEmail` from your organization's distribution list rather than committing a
personal address.

Rotate the API key by adding the replacement to `API_KEYS`, deploying, moving clients, then removing
the old key. Key Vault references are versionless; create a new revision or restart replicas after
rotation.

Destroy the example by deleting its generated resource group after confirming it contains no
shared resources.
