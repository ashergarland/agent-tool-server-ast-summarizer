using '../main.bicep'

param environmentName = 'dev'
param location = 'eastus'
param deployApp = false
param containerImage = 'contoso.azurecr.io/agent-tool-server-ast-summarizer:0.1.0'

// Hosting is opt-in. Leave the storage name blank until a read-only source share exists; the app
// then deploys, stays live, and reports not ready rather than pretending to serve analysis.
param workspaceStorageName = ''
param workspaceMountPath = '/workspace'

param cpu = '0.25'
param memory = '0.5Gi'
param astMaxConcurrentJobs = 2
param astMaxQueuedJobs = 8
param httpConcurrentRequests = 4

param minReplicas = 0
param maxReplicas = 3
