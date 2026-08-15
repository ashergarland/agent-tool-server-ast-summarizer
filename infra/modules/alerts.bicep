@description('Resource ID of the container app the alerts observe.')
param appResourceId string

@description('Alert rule name prefix.')
param namePrefix string

@description('Optional email address for notifications. Leave blank to create alerts without an action group.')
param notificationEmail string

@description('Container restarts within the evaluation window that indicate an unhealthy revision.')
@minValue(1)
param restartThreshold int

@description('Server failures within the evaluation window that indicate a broken deployment.')
@minValue(1)
param failureThreshold int

param tags object

var hasNotification = !empty(notificationEmail)

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (hasNotification) {
  name: '${namePrefix}-ag'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take(namePrefix, 12)
    enabled: true
    emailReceivers: [
      {
        name: 'operators'
        emailAddress: notificationEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

var actions = hasNotification
  ? [
      {
        actionGroupId: actionGroup!.id
      }
    ]
  : []

resource restartAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-restarts'
  location: 'global'
  tags: tags
  properties: {
    description: 'Container restarts suggest the revision cannot start or stay healthy.'
    severity: 2
    enabled: true
    scopes: [appResourceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'restarts'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'RestartCount'
          operator: 'GreaterThan'
          threshold: restartThreshold
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: actions
  }
}

resource failureAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${namePrefix}-failures'
  location: 'global'
  tags: tags
  properties: {
    description: 'Sustained 5xx responses indicate a failing tool server rather than caller error.'
    severity: 2
    enabled: true
    scopes: [appResourceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'serverErrors'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          operator: 'GreaterThan'
          threshold: failureThreshold
          timeAggregation: 'Total'
          criterionType: 'StaticThresholdCriterion'
          dimensions: [
            {
              name: 'statusCodeCategory'
              operator: 'Include'
              values: ['5xx']
            }
          ]
        }
      ]
    }
    actions: actions
  }
}

output restartAlertName string = restartAlert.name
output failureAlertName string = failureAlert.name
