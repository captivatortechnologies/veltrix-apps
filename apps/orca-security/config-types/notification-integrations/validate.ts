import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeStringList } from '../../lib/reconcile'
import { SERVICES, WEBHOOK_TYPES, type IntegrationService } from './_shared'

function isValidJsonObjectOrEmpty(raw: unknown): boolean {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return true
  try {
    const parsed = JSON.parse(s)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/**
 * Validate notification-integration items: a non-empty template name (the
 * identity), a known service, and that service's required fields. Static —
 * no target access required. A duplicate (service, templateName) pair is
 * flagged, since that is what Orca's own lookup key resolves by.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one notification integration.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const templateName = String(item.fields.templateName ?? '').trim()
    const service = String(item.fields.service ?? '').trim() as IntegrationService

    if (!templateName) {
      errors.push({ field: `items[${i}].templateName`, message: 'Template name is required.', code: 'EMPTY_TEMPLATE_NAME' })
    }
    if (!SERVICES.has(service)) {
      errors.push({ field: `items[${i}].service`, message: `Service must be one of jira, slack, webhook (got "${service}").`, code: 'INVALID_SERVICE' })
      return
    }

    const key = `${service}:${templateName}`
    if (templateName) {
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].templateName`,
          message: `"${templateName}" (${service}) is listed more than once; the last one wins.`,
          code: 'DUPLICATE_TEMPLATE',
        })
      } else {
        seen.add(key)
      }
    }

    if (service === 'jira') {
      if (!String(item.fields.jiraResourceId ?? '').trim()) {
        errors.push({ field: `items[${i}].jiraResourceId`, message: 'Jira OAuth resource ID is required.', code: 'EMPTY_JIRA_RESOURCE_ID' })
      }
      if (!String(item.fields.jiraResourceUrl ?? '').trim()) {
        errors.push({ field: `items[${i}].jiraResourceUrl`, message: 'Jira tenant URL is required.', code: 'EMPTY_JIRA_RESOURCE_URL' })
      }
      if (!String(item.fields.jiraProjectId ?? '').trim()) {
        errors.push({ field: `items[${i}].jiraProjectId`, message: 'Jira project ID is required.', code: 'EMPTY_JIRA_PROJECT_ID' })
      }
      if (!String(item.fields.jiraIssueTypeId ?? '').trim()) {
        errors.push({ field: `items[${i}].jiraIssueTypeId`, message: 'Jira issue type ID is required.', code: 'EMPTY_JIRA_ISSUE_TYPE_ID' })
      }
      if (!String(item.fields.jiraMappingJson ?? '').trim()) {
        errors.push({ field: `items[${i}].jiraMappingJson`, message: 'Field mapping JSON is required for Jira.', code: 'EMPTY_JIRA_MAPPING' })
      } else if (!isValidJsonObjectOrEmpty(item.fields.jiraMappingJson)) {
        errors.push({ field: `items[${i}].jiraMappingJson`, message: 'Field mapping must be a JSON object.', code: 'INVALID_JIRA_MAPPING' })
      }
      for (const key2 of [
        'jiraAlertStatusMappingJson',
        'jiraTicketStatusMappingJson',
        'jiraSubtaskAlertStatusMappingJson',
        'jiraSubtaskTicketStatusMappingJson',
      ]) {
        if (!isValidJsonObjectOrEmpty(item.fields[key2])) {
          errors.push({ field: `items[${i}].${key2}`, message: 'Must be a JSON object, or left blank.', code: 'INVALID_JIRA_MAPPING' })
        }
      }
    }

    if (service === 'slack') {
      if (!String(item.fields.slackWorkspaceId ?? '').trim()) {
        errors.push({ field: `items[${i}].slackWorkspaceId`, message: 'Slack workspace ID is required.', code: 'EMPTY_SLACK_WORKSPACE_ID' })
      }
      if (normalizeStringList(item.fields.slackChannels).length === 0) {
        errors.push({ field: `items[${i}].slackChannels`, message: 'At least one Slack channel ID is required.', code: 'EMPTY_SLACK_CHANNELS' })
      }
      if (!String(item.fields.slackMappingJson ?? '').trim()) {
        errors.push({ field: `items[${i}].slackMappingJson`, message: 'Field mapping JSON is required for Slack.', code: 'EMPTY_SLACK_MAPPING' })
      } else if (!isValidJsonObjectOrEmpty(item.fields.slackMappingJson)) {
        errors.push({ field: `items[${i}].slackMappingJson`, message: 'Field mapping must be a JSON object.', code: 'INVALID_SLACK_MAPPING' })
      }
    }

    if (service === 'webhook') {
      if (!String(item.fields.webhookUrl ?? '').trim()) {
        errors.push({ field: `items[${i}].webhookUrl`, message: 'Webhook URL is required.', code: 'EMPTY_WEBHOOK_URL' })
      }
      const webhookType = String(item.fields.webhookType ?? '').trim() || 'common'
      if (!WEBHOOK_TYPES.has(webhookType)) {
        errors.push({
          field: `items[${i}].webhookType`,
          message: `Webhook variant must be one of ${[...WEBHOOK_TYPES].join(', ')} (got "${webhookType}").`,
          code: 'INVALID_WEBHOOK_TYPE',
        })
      }
      if (!isValidJsonObjectOrEmpty(item.fields.webhookCustomHeadersJson)) {
        errors.push({ field: `items[${i}].webhookCustomHeadersJson`, message: 'Custom headers must be a JSON object, or left blank.', code: 'INVALID_WEBHOOK_HEADERS' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
