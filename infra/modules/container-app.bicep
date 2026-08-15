param location string
param environmentName string
param appName string
param containerImage string
param registryServer string
param identityId string
param apiKeySecretUri string
param logAnalyticsCustomerId string
@secure()
param logAnalyticsSharedKey string
@secure()
param applicationInsightsConnectionString string

@description('vCPU allocated to the container. Analysis is CPU-bound, so concurrency is sized from this.')
param cpu string

@description('Memory allocated to the container, for example 0.5Gi.')
param memory string

@description('Concurrent analysis jobs. Keep this at or below the available vCPU budget.')
@minValue(1)
@maxValue(64)
param astMaxConcurrentJobs int

@description('Queued analysis jobs. Surplus demand is rejected as a retryable busy error.')
@minValue(0)
@maxValue(1024)
param astMaxQueuedJobs int

@description('HTTP concurrency used for scaling. Align it with analysis capacity, not with cheap requests.')
@minValue(1)
param httpConcurrentRequests int

@description('Name of a pre-created read-only environment storage. Leave blank to deploy without a workspace; the app then stays live but never reports ready.')
param workspaceStorageName string

@description('Mount path for the read-only workspace volume.')
param workspaceMountPath string

@description('Deployment analysis ceilings. A tool call may lower any of these but can never raise one.')
param analysisLimits object

param minReplicas int
param maxReplicas int
param tags object

var hasWorkspace = !empty(workspaceStorageName)

var baseEnvironment = [
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'AUTH_MODE'
    value: 'api-key'
  }
  {
    name: 'API_KEYS'
    secretRef: 'api-key'
  }
  {
    name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
    value: applicationInsightsConnectionString
  }
  {
    name: 'AST_MAX_CONCURRENT_JOBS'
    value: string(astMaxConcurrentJobs)
  }
  {
    name: 'AST_MAX_QUEUED_JOBS'
    value: string(astMaxQueuedJobs)
  }
  {
    name: 'AST_MAX_FILE_BYTES'
    value: string(analysisLimits.maxFileBytes)
  }
  {
    name: 'AST_MAX_TOTAL_BYTES'
    value: string(analysisLimits.maxTotalBytes)
  }
  {
    name: 'AST_MAX_DEPTH'
    value: string(analysisLimits.maxDepth)
  }
  {
    name: 'AST_MAX_FILES'
    value: string(analysisLimits.maxFiles)
  }
  {
    name: 'AST_MAX_EDGES'
    value: string(analysisLimits.maxEdges)
  }
  {
    name: 'AST_MAX_DECLARATIONS'
    value: string(analysisLimits.maxDeclarations)
  }
  {
    name: 'AST_MAX_MEMBERS'
    value: string(analysisLimits.maxMembersPerDeclaration)
  }
  {
    name: 'AST_MAX_JSDOC_CHARS'
    value: string(analysisLimits.maxJsDocChars)
  }
  {
    name: 'AST_MAX_RESULT_CHARS'
    value: string(analysisLimits.maxResultChars)
  }
  {
    name: 'AST_REQUEST_TIMEOUT_MS'
    value: string(analysisLimits.requestTimeoutMs)
  }
]

var workspaceEnvironment = hasWorkspace
  ? [
      {
        name: 'AST_WORKSPACE_ROOT'
        value: workspaceMountPath
      }
    ]
  : []

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registryServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'api-key'
          keyVaultUrl: apiKeySecretUri
          identity: identityId
        }
      ]
    }
    template: {
      volumes: hasWorkspace
        ? [
            {
              name: 'workspace'
              storageType: 'AzureFile'
              storageName: workspaceStorageName
            }
          ]
        : []
      containers: [
        {
          name: 'tool-server'
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: concat(baseEnvironment, workspaceEnvironment)
          volumeMounts: hasWorkspace
            ? [
                {
                  volumeName: 'workspace'
                  mountPath: workspaceMountPath
                }
              ]
            : []
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(httpConcurrentRequests)
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output appResourceId string = app.id
