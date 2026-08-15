targetScope = 'subscription'

@description('Short environment suffix such as dev, test, or prod.')
@minLength(2)
@maxLength(12)
param environmentName string

@description('Azure region for all resources.')
param location string = deployment().location

@description('Immutable container image reference used on the second pass.')
param containerImage string = 'contoso.azurecr.io/agent-tool-server-ast-summarizer:0.1.0'

@description('False for the prerequisite pass; true only after the Key Vault secret and image exist.')
param deployApp bool = false

@description('Existing Key Vault secret name used by the application.')
param apiKeySecretName string = 'tool-server-api-key'

@description('Object ID allowed to seed the Key Vault secret during bootstrap; leave blank outside bootstrap.')
param bootstrapPrincipalObjectId string = ''

@description('vCPU for the container. Analysis is CPU-bound.')
param cpu string = '0.25'

@description('Memory for the container.')
param memory string = '0.5Gi'

@description('Concurrent analysis jobs. Two is the practical ceiling for 0.25 vCPU.')
@minValue(1)
@maxValue(64)
param astMaxConcurrentJobs int = 2

@description('Queued analysis jobs before callers receive a retryable busy error.')
@minValue(0)
@maxValue(1024)
param astMaxQueuedJobs int = 8

@description('HTTP concurrency for the scale rule. Keep it aligned with analysis capacity, not with cheap requests.')
@minValue(1)
param httpConcurrentRequests int = 4

@description('Name of a pre-created read-only environment storage holding the source workspace. Blank means the app deploys but never reports ready.')
param workspaceStorageName string = ''

@description('Mount path for the read-only workspace volume.')
param workspaceMountPath string = '/workspace'

@description('Deployment analysis ceilings. A tool call may lower any of these but can never raise one.')
param analysisLimits object = {
  maxFileBytes: 1048576
  maxTotalBytes: 8388608
  maxDepth: 8
  maxFiles: 200
  maxEdges: 2000
  maxDeclarations: 500
  maxMembersPerDeclaration: 200
  maxJsDocChars: 600
  maxResultChars: 120000
  requestTimeoutMs: 15000
}

@description('Optional email address for alert notifications.')
param alertNotificationEmail string = ''

@description('Container restarts in fifteen minutes that should raise an alert.')
@minValue(1)
param alertRestartThreshold int = 3

@description('Server failures in fifteen minutes that should raise an alert.')
@minValue(1)
param alertFailureThreshold int = 10

@description('Minimum replicas. Keep zero for scale-to-zero.')
@minValue(0)
param minReplicas int = 0

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 3

@description('Tags applied to every resource.')
param tags object = {
  application: 'agent-tool-server-ast-summarizer'
  managedBy: 'bicep'
}

var suffix = uniqueString(subscription().id, environmentName)
var resourceGroupName = 'rg-ats-${environmentName}-${suffix}'
var resourceTags = union(tags, { environment: environmentName })

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: resourceTags
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: resourceGroup
  params: {
    location: location
    name: 'id-ats-${environmentName}-${suffix}'
    tags: resourceTags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'registry'
  scope: resourceGroup
  params: {
    location: location
    name: 'crats${suffix}'
    pullPrincipalId: identity.outputs.principalId
    tags: resourceTags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  scope: resourceGroup
  params: {
    location: location
    name: 'kv-ats-${suffix}'
    accessPrincipalObjectId: identity.outputs.principalId
    bootstrapPrincipalObjectId: bootstrapPrincipalObjectId
    tags: resourceTags
  }
}

module observability 'modules/observability.bicep' = {
  name: 'observability'
  scope: resourceGroup
  params: {
    location: location
    workspaceName: 'log-ats-${environmentName}-${suffix}'
    insightsName: 'appi-ats-${environmentName}-${suffix}'
    tags: resourceTags
  }
}

module app 'modules/container-app.bicep' = if (deployApp) {
  name: 'container-app'
  scope: resourceGroup
  params: {
    location: location
    environmentName: 'cae-ats-${environmentName}-${suffix}'
    appName: 'ca-ats-${environmentName}-${suffix}'
    containerImage: containerImage
    registryServer: registry.outputs.loginServer
    identityId: identity.outputs.id
    apiKeySecretUri: '${keyVault.outputs.vaultUri}secrets/${apiKeySecretName}'
    logAnalyticsCustomerId: observability.outputs.workspaceCustomerId
    logAnalyticsSharedKey: observability.outputs.workspaceSharedKey
    applicationInsightsConnectionString: observability.outputs.applicationInsightsConnectionString
    cpu: cpu
    memory: memory
    astMaxConcurrentJobs: astMaxConcurrentJobs
    astMaxQueuedJobs: astMaxQueuedJobs
    httpConcurrentRequests: httpConcurrentRequests
    workspaceStorageName: workspaceStorageName
    workspaceMountPath: workspaceMountPath
    analysisLimits: analysisLimits
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    tags: resourceTags
  }
}

module alerts 'modules/alerts.bicep' = if (deployApp) {
  name: 'alerts'
  scope: resourceGroup
  params: {
    appResourceId: app!.outputs.appResourceId
    namePrefix: 'ats-${environmentName}'
    notificationEmail: alertNotificationEmail
    restartThreshold: alertRestartThreshold
    failureThreshold: alertFailureThreshold
    tags: resourceTags
  }
}

output resourceGroupName string = resourceGroupName
output registryName string = registry.outputs.name
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output managedIdentityClientId string = identity.outputs.clientId
output applicationUrl string = deployApp ? 'https://${app!.outputs.fqdn}' : ''
output workspaceConfigured bool = !empty(workspaceStorageName)
