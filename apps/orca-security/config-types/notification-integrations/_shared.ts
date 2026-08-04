// Shared helpers for the Orca Notification Integrations config type (deploy +
// rollback + drift).
//
// All three services this type manages ride on ONE base resource,
// /api/external_service/config (VERIFIED against terraform-provider-orcasecurity
// api_client/external_service_config.go, jira_cloud_template.go,
// slack_template.go, webhook_resource.go):
//   POST   /api/external_service/config                                     create
//   GET    /api/external_service/config?service_name=&template_name=        read — a LIST filtered by both, so this
//                                                                            genuinely looks a template up by its own
//                                                                            human-assigned name (unlike every other
//                                                                            Orca resource in this app)
//   PUT    /api/external_service/config/{service}?template={templateName}   update
//   DELETE /api/external_service/config/{service}?template={templateName}   delete
//
// Because GET can resolve a template by (service, template_name), identity
// here is NOT resolved only from rollbackData the way every other type in this
// app resolves it — deploy always looks the live entry up first. rollbackData
// still records the server id + prior body so rollback can restore/delete
// without another lookup pass.
//
// Per-service PUT quirk (verified in the provider's Update* methods):
//   - jira, slack : the update body must NOT include business_units — Orca
//     rejects the request with "You can't change business units". This app
//     therefore treats businessUnits as CREATE-TIME ONLY for these two
//     services; changing it later requires deleting and recreating the item.
//   - webhook     : the update body MAY include business_units — Orca accepts
//     changing it, so this app forwards it on every update.
//
// webhookApiKey is treated as write-only for drift/logging purposes even
// though Orca's GET technically echoes it back — matching this codebase's
// existing "password" field convention (e.g. jfrog-xray webhooks) of never
// diffing or displaying a secret value.

import { normalizeBool, normalizeStringList } from '../../lib/reconcile'

export type IntegrationService = 'jira' | 'slack' | 'webhook'
export const SERVICES = new Set<IntegrationService>(['jira', 'slack', 'webhook'])
export const WEBHOOK_TYPES = new Set<string>(['common', 'torq', 'tines', 'opus', 'coralogix', 'panther'])

/** Whether a PUT (update) may include business_units. Only webhook's API accepts it. */
export function updateAllowsBusinessUnits(service: string): boolean {
  return service === 'webhook'
}

/** The generic /api/external_service/config envelope every service shares. */
export interface IntegrationEnvelope {
  id?: string
  service_name?: string
  template_name?: string
  config?: Record<string, unknown>
  is_enabled?: boolean
  is_default?: boolean
  business_units?: string[]
  [key: string]: unknown
}

/** One entry recorded per canvas item in rollbackData.previous. */
export interface IntegrationRollbackEntry {
  itemId: string
  name: string
  service: IntegrationService | ''
  serverId: string | null
  existed: boolean
  prior: IntegrationEnvelope | null
}

/** The shape deploy writes and rollback/drift read from rollbackData. */
export interface IntegrationRollbackData {
  previous?: IntegrationRollbackEntry[]
}

/** Build the per-service `config` block from canvas fields. */
export function buildConfig(service: IntegrationService, fields: Record<string, unknown>): Record<string, unknown> {
  switch (service) {
    case 'jira':
      return buildJiraConfig(fields)
    case 'slack':
      return buildSlackConfig(fields)
    case 'webhook':
      return buildWebhookConfig(fields)
  }
}

function optionalJson(raw: unknown): unknown {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

function requiredJson(raw: unknown): unknown {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return {}
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}

function buildJiraConfig(fields: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {
    resource_id: String(fields.jiraResourceId ?? '').trim(),
    resource_url: String(fields.jiraResourceUrl ?? '').trim(),
    project_id: String(fields.jiraProjectId ?? '').trim(),
    issue_type_id: String(fields.jiraIssueTypeId ?? '').trim(),
    mapping: requiredJson(fields.jiraMappingJson),
  }
  const subtaskIssueTypeId = String(fields.jiraSubtaskIssueTypeId ?? '').trim()
  if (subtaskIssueTypeId) config.subtask_issue_type_id = subtaskIssueTypeId
  const alertStatusMapping = optionalJson(fields.jiraAlertStatusMappingJson)
  if (alertStatusMapping !== undefined) config.alert_status_mapping = alertStatusMapping
  const ticketStatusMapping = optionalJson(fields.jiraTicketStatusMappingJson)
  if (ticketStatusMapping !== undefined) config.ticket_status_mapping = ticketStatusMapping
  const subtaskAlertStatusMapping = optionalJson(fields.jiraSubtaskAlertStatusMappingJson)
  if (subtaskAlertStatusMapping !== undefined) config.subtask_alert_status_mapping = subtaskAlertStatusMapping
  const subtaskTicketStatusMapping = optionalJson(fields.jiraSubtaskTicketStatusMappingJson)
  if (subtaskTicketStatusMapping !== undefined) config.subtask_ticket_status_mapping = subtaskTicketStatusMapping
  return config
}

function buildSlackConfig(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    workspace_id: String(fields.slackWorkspaceId ?? '').trim(),
    channels: normalizeStringList(fields.slackChannels),
    show_actions: normalizeBool(fields.slackShowActions, true),
    mapping: requiredJson(fields.slackMappingJson),
  }
}

function buildWebhookConfig(fields: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {
    webhook_url: String(fields.webhookUrl ?? '').trim(),
    type: String(fields.webhookType ?? '').trim() || 'common',
  }
  const apiKey = String(fields.webhookApiKey ?? '').trim()
  if (apiKey) config.api_key = apiKey
  const bodyFields = normalizeStringList(fields.webhookBodyFields)
  if (bodyFields.length > 0) config.body_fields = bodyFields
  const customHeaders = optionalJson(fields.webhookCustomHeadersJson)
  if (customHeaders !== undefined) config.custom_headers = customHeaders
  return config
}

/** Build the full create-time envelope body (service_name + template_name + config + flags). */
export function buildCreateBody(
  service: IntegrationService,
  templateName: string,
  fields: Record<string, unknown>,
): IntegrationEnvelope {
  return {
    service_name: service,
    template_name: templateName,
    config: buildConfig(service, fields),
    is_enabled: normalizeBool(fields.isEnabled, true),
    is_default: normalizeBool(fields.isDefault, false),
    business_units: normalizeStringList(fields.businessUnits),
  }
}

/** Build the update body — omits business_units unless this service's API accepts changing it. */
export function buildUpdateBody(
  service: IntegrationService,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    is_enabled: normalizeBool(fields.isEnabled, true),
    is_default: normalizeBool(fields.isDefault, false),
    config: buildConfig(service, fields),
  }
  if (updateAllowsBusinessUnits(service)) {
    body.business_units = normalizeStringList(fields.businessUnits)
  }
  return body
}

/** Build the restore body used by rollback from a recorded prior envelope. */
export function buildRestoreBody(service: IntegrationService, prior: IntegrationEnvelope): Record<string, unknown> {
  const body: Record<string, unknown> = {
    is_enabled: prior.is_enabled ?? true,
    is_default: prior.is_default ?? false,
    config: prior.config ?? {},
  }
  if (updateAllowsBusinessUnits(service)) {
    body.business_units = prior.business_units ?? []
  }
  return body
}

/** Strip write-only secret fields (e.g. webhook's api_key) before a drift comparison. */
export function stripSecrets(service: IntegrationService, config: Record<string, unknown> | undefined): Record<string, unknown> {
  const copy = { ...(config ?? {}) }
  if (service === 'webhook') delete copy.api_key
  return copy
}
