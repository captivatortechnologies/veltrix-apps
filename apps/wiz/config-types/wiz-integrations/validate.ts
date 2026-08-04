import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Wiz integration constraints ----------------------------------------------
//
// The 11 integration types below are the only ones with a
// `Create*IntegrationParamsInput` in the verified Wiz GraphQL SDK type surface
// (terraform-provider-wiz's internal/wiz Go package) — every other
// `IntegrationType` enum value is OAuth/browser-flow-only. See canvas.yaml.

export const INTEGRATION_TYPES = [
  'WEBHOOK',
  'SLACK',
  'SLACK_BOT',
  'AWS_SNS',
  'AZURE_SERVICE_BUS',
  'GCP_PUB_SUB',
  'PAGER_DUTY',
  'JIRA',
  'SERVICE_NOW',
  'OPSGENIE',
  'CLICK_UP',
] as const

export const AWS_SNS_ACCESS_METHODS = ['ASSUME_CONNECTOR_ROLE', 'ASSUME_SPECIFIED_ROLE'] as const
export const AZURE_SERVICE_BUS_ACCESS_METHODS = ['CONNECTOR_CREDENTIALS', 'CONNECTION_STRING_WITH_SAS'] as const
export const GCP_PUB_SUB_ACCESS_METHODS = ['CONNECTOR_CREDENTIALS', 'SERVICE_ACCOUNT_KEY'] as const
export const JIRA_SERVER_TYPES = ['CLOUD', 'SELF_HOSTED'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IntegrationSpec {
  sectionName: string
  name: string
  integrationType: string
  projectId: string
  isAccessibleToAllProjects: boolean

  webhookUrl: string
  webhookIsOnPrem: boolean
  webhookAuthUsername: string
  webhookAuthPassword: string
  webhookAuthToken: string
  webhookHeadersJson: string
  webhookTlsAllowInsecure: boolean
  webhookTlsServerCa: string

  slackWebhookUrl: string

  slackBotToken: string

  awsSnsTopicArn: string
  awsSnsAccessMethodType: string
  awsSnsAccessConnectorId: string
  awsSnsCustomerRoleArn: string

  azureQueueUrl: string
  azureAccessMethodType: string
  azureAccessConnectorId: string
  azureConnectionStringWithSas: string

  gcpProjectId: string
  gcpTopicId: string
  gcpAccessMethodType: string
  gcpAccessConnectorId: string
  gcpServiceAccountKey: string

  pagerDutyIntegrationKey: string

  jiraServerUrl: string
  jiraServerType: string
  jiraIsOnPrem: boolean
  jiraTlsAllowInsecure: boolean
  jiraTlsServerCa: string
  jiraTlsClientCertAndKey: string
  jiraAuthUsername: string
  jiraAuthPassword: string
  jiraAuthPat: string

  serviceNowUrl: string
  serviceNowAuthUsername: string
  serviceNowAuthPassword: string
  serviceNowAuthClientId: string
  serviceNowAuthClientSecret: string

  opsgenieKey: string
  clickUpKey: string
}

/** An integration as returned by the `integrations` list query. */
export interface LiveIntegration {
  id?: string
  name?: string
  type?: string
}

/** The integration's logical identity: its name (case-insensitive, trimmed). */
export function integrationKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Try to parse JSON text; empty text is treated as absent (ok, undefined value). */
export function tryParseJson(text: string): { value: unknown; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    return { value: JSON.parse(trimmed), ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

/** Each canvas item describes one Wiz integration. */
export function extractIntegrationSpecs(canvas: CanvasSnapshot): IntegrationSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      integrationType: str(fields.integration_type) || 'WEBHOOK',
      projectId: str(fields.project_id),
      isAccessibleToAllProjects: readBool(fields.is_accessible_to_all_projects, true),

      webhookUrl: str(fields.webhook_url),
      webhookIsOnPrem: readBool(fields.webhook_is_on_prem, false),
      webhookAuthUsername: str(fields.webhook_auth_username),
      webhookAuthPassword: str(fields.webhook_auth_password),
      webhookAuthToken: str(fields.webhook_auth_token),
      webhookHeadersJson: str(fields.webhook_headers_json),
      webhookTlsAllowInsecure: readBool(fields.webhook_tls_allow_insecure, false),
      webhookTlsServerCa: str(fields.webhook_tls_server_ca),

      slackWebhookUrl: str(fields.slack_webhook_url),

      slackBotToken: str(fields.slack_bot_token),

      awsSnsTopicArn: str(fields.aws_sns_topic_arn),
      awsSnsAccessMethodType: str(fields.aws_sns_access_method_type) || 'ASSUME_CONNECTOR_ROLE',
      awsSnsAccessConnectorId: str(fields.aws_sns_access_connector_id),
      awsSnsCustomerRoleArn: str(fields.aws_sns_customer_role_arn),

      azureQueueUrl: str(fields.azure_service_bus_queue_url),
      azureAccessMethodType: str(fields.azure_access_method_type) || 'CONNECTOR_CREDENTIALS',
      azureAccessConnectorId: str(fields.azure_access_connector_id),
      azureConnectionStringWithSas: str(fields.azure_connection_string_with_sas),

      gcpProjectId: str(fields.gcp_project_id),
      gcpTopicId: str(fields.gcp_topic_id),
      gcpAccessMethodType: str(fields.gcp_access_method_type) || 'CONNECTOR_CREDENTIALS',
      gcpAccessConnectorId: str(fields.gcp_access_connector_id),
      gcpServiceAccountKey: str(fields.gcp_service_account_key),

      pagerDutyIntegrationKey: str(fields.pagerduty_integration_key),

      jiraServerUrl: str(fields.jira_server_url),
      jiraServerType: str(fields.jira_server_type) || 'CLOUD',
      jiraIsOnPrem: readBool(fields.jira_is_on_prem, false),
      jiraTlsAllowInsecure: readBool(fields.jira_tls_allow_insecure, false),
      jiraTlsServerCa: str(fields.jira_tls_server_ca),
      jiraTlsClientCertAndKey: str(fields.jira_tls_client_cert_and_key),
      jiraAuthUsername: str(fields.jira_auth_username),
      jiraAuthPassword: str(fields.jira_auth_password),
      jiraAuthPat: str(fields.jira_auth_pat),

      serviceNowUrl: str(fields.servicenow_url),
      serviceNowAuthUsername: str(fields.servicenow_auth_username),
      serviceNowAuthPassword: str(fields.servicenow_auth_password),
      serviceNowAuthClientId: str(fields.servicenow_auth_client_id),
      serviceNowAuthClientSecret: str(fields.servicenow_auth_client_secret),

      opsgenieKey: str(fields.opsgenie_key),
      clickUpKey: str(fields.clickup_key),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz integration configurations: name is required and unique across
 * the canvas (case-insensitive); integration_type must be one of the 11
 * API-manageable types; and each type's own required fields (verified against
 * `Create<Type>IntegrationParamsInput`) are enforced.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIntegrationSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Integration name is required', code: 'required' })
    }
    if (!INTEGRATION_TYPES.includes(spec.integrationType as (typeof INTEGRATION_TYPES)[number])) {
      errors.push({
        field: `${prefix}.integration_type`,
        message: `Unsupported integration type "${spec.integrationType}"`,
        code: 'invalid_integration_type',
      })
    } else {
      validateTypeFields(spec, prefix, errors)
    }

    const headers = tryParseJson(spec.webhookHeadersJson)
    if (!headers.ok) {
      errors.push({ field: `${prefix}.webhook_headers_json`, message: 'Custom headers must be valid JSON', code: 'invalid_json' })
    } else if (headers.value !== undefined && !Array.isArray(headers.value)) {
      errors.push({
        field: `${prefix}.webhook_headers_json`,
        message: 'Custom headers must be a JSON array of {"key","value"} objects',
        code: 'invalid_headers',
      })
    }

    if (spec.name) {
      const key = integrationKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate integration "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_integration',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Enforce the required fields for the declared integration_type. */
function validateTypeFields(spec: IntegrationSpec, prefix: string, errors: ValidationResult['errors']): void {
  const require = (ok: boolean, field: string, message: string): void => {
    if (!ok) errors.push({ field: `${prefix}.${field}`, message, code: 'required' })
  }

  switch (spec.integrationType) {
    case 'WEBHOOK':
      require(!!spec.webhookUrl, 'webhook_url', 'A webhook URL is required')
      break
    case 'SLACK':
      require(!!spec.slackWebhookUrl, 'slack_webhook_url', 'A Slack incoming-webhook URL is required')
      break
    case 'SLACK_BOT':
      require(!!spec.slackBotToken, 'slack_bot_token', 'A Slack bot token is required')
      break
    case 'AWS_SNS':
      require(!!spec.awsSnsTopicArn, 'aws_sns_topic_arn', 'A Topic ARN is required')
      if (!AWS_SNS_ACCESS_METHODS.includes(spec.awsSnsAccessMethodType as (typeof AWS_SNS_ACCESS_METHODS)[number])) {
        errors.push({ field: `${prefix}.aws_sns_access_method_type`, message: 'Unsupported access method', code: 'invalid_access_method' })
      } else if (spec.awsSnsAccessMethodType === 'ASSUME_CONNECTOR_ROLE') {
        require(!!spec.awsSnsAccessConnectorId, 'aws_sns_access_connector_id', 'A connector id is required for Assume Connector Role')
      } else {
        require(!!spec.awsSnsCustomerRoleArn, 'aws_sns_customer_role_arn', 'A customer role ARN is required for Assume Specified Role')
      }
      break
    case 'AZURE_SERVICE_BUS':
      require(!!spec.azureQueueUrl, 'azure_service_bus_queue_url', 'A queue URL is required')
      if (
        !AZURE_SERVICE_BUS_ACCESS_METHODS.includes(spec.azureAccessMethodType as (typeof AZURE_SERVICE_BUS_ACCESS_METHODS)[number])
      ) {
        errors.push({ field: `${prefix}.azure_access_method_type`, message: 'Unsupported access method', code: 'invalid_access_method' })
      } else if (spec.azureAccessMethodType === 'CONNECTOR_CREDENTIALS') {
        require(!!spec.azureAccessConnectorId, 'azure_access_connector_id', 'A connector id is required for Connector Credentials')
      } else {
        require(
          !!spec.azureConnectionStringWithSas,
          'azure_connection_string_with_sas',
          'A connection string is required for Connection String With SAS',
        )
      }
      break
    case 'GCP_PUB_SUB':
      require(!!spec.gcpProjectId, 'gcp_project_id', 'A GCP project id is required')
      require(!!spec.gcpTopicId, 'gcp_topic_id', 'A topic id is required')
      if (!GCP_PUB_SUB_ACCESS_METHODS.includes(spec.gcpAccessMethodType as (typeof GCP_PUB_SUB_ACCESS_METHODS)[number])) {
        errors.push({ field: `${prefix}.gcp_access_method_type`, message: 'Unsupported access method', code: 'invalid_access_method' })
      } else if (spec.gcpAccessMethodType === 'CONNECTOR_CREDENTIALS') {
        require(!!spec.gcpAccessConnectorId, 'gcp_access_connector_id', 'A connector id is required for Connector Credentials')
      } else {
        require(!!spec.gcpServiceAccountKey, 'gcp_service_account_key', 'A service-account key is required for Service Account Key')
      }
      break
    case 'PAGER_DUTY':
      require(!!spec.pagerDutyIntegrationKey, 'pagerduty_integration_key', 'An integration key is required')
      break
    case 'JIRA':
      require(!!spec.jiraServerUrl, 'jira_server_url', 'A server URL is required')
      if (!JIRA_SERVER_TYPES.includes(spec.jiraServerType as (typeof JIRA_SERVER_TYPES)[number])) {
        errors.push({ field: `${prefix}.jira_server_type`, message: 'Unsupported server type', code: 'invalid_server_type' })
      }
      require(
        !!(spec.jiraAuthPat || (spec.jiraAuthUsername && spec.jiraAuthPassword)),
        'jira_auth_password',
        'Either a Personal Access Token, or a username + password, is required',
      )
      break
    case 'SERVICE_NOW':
      require(!!spec.serviceNowUrl, 'servicenow_url', 'An instance URL is required')
      require(!!spec.serviceNowAuthUsername, 'servicenow_auth_username', 'A username is required')
      require(!!spec.serviceNowAuthPassword, 'servicenow_auth_password', 'A password is required')
      break
    case 'OPSGENIE':
      require(!!spec.opsgenieKey, 'opsgenie_key', 'An API key is required')
      break
    case 'CLICK_UP':
      require(!!spec.clickUpKey, 'clickup_key', 'An API key is required')
      break
  }
}
