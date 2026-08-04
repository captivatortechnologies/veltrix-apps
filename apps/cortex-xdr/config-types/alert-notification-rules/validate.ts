import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NOTIFICATION_FORMATS, SLACK_FORMATS, isValidFilterJson } from './_shared'

/**
 * Validate alert-notification-rule items: a non-empty name, a non-empty
 * forward_type, valid JSON for the required filter, at least one forward
 * channel (email / Slack / Syslog), and known format values when provided.
 * Static — no target access required. The name doubles as the rule's identity,
 * so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one alert notification rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const forwardType = String(item.fields.forward_type ?? '').trim()
    const mailFormat = String(item.fields.mail_format ?? '').trim()
    const syslogFormat = String(item.fields.syslog_format ?? '').trim()
    const slackFormat = String(item.fields.slack_format ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Rule "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!forwardType) {
      errors.push({ field: `items[${i}].forward_type`, message: 'Forward type is required (e.g. "alert"). VERIFY the accepted values against your Cortex XDR tenant.', code: 'EMPTY_FORWARD_TYPE' })
    }

    if (!isValidFilterJson(item.fields.filter)) {
      errors.push({ field: `items[${i}].filter`, message: 'Filter is required and must be a valid JSON object.', code: 'INVALID_FILTER_JSON' })
    }

    const hasEmail = Array.isArray(item.fields.email_distribution_list) && (item.fields.email_distribution_list as unknown[]).length > 0
    const hasSlack = Array.isArray(item.fields.slack_channels) && (item.fields.slack_channels as unknown[]).length > 0
    const hasSyslog = Number(item.fields.syslog_integration_id ?? 0) > 0
    if (!hasEmail && !hasSlack && !hasSyslog) {
      errors.push({ field: `items[${i}]`, message: 'At least one forward channel is required: email distribution list, Slack channels, or a Syslog integration id.', code: 'NO_FORWARD_CHANNEL' })
    }

    if (mailFormat && !NOTIFICATION_FORMATS.has(mailFormat)) {
      errors.push({ field: `items[${i}].mail_format`, message: `Mail format must be one of ${[...NOTIFICATION_FORMATS].join(', ')} (got "${mailFormat}").`, code: 'INVALID_MAIL_FORMAT' })
    }
    if (syslogFormat && !NOTIFICATION_FORMATS.has(syslogFormat)) {
      errors.push({ field: `items[${i}].syslog_format`, message: `Syslog format must be one of ${[...NOTIFICATION_FORMATS].join(', ')} (got "${syslogFormat}").`, code: 'INVALID_SYSLOG_FORMAT' })
    }
    if (slackFormat && !SLACK_FORMATS.has(slackFormat)) {
      errors.push({ field: `items[${i}].slack_format`, message: `Slack format must be one of ${[...SLACK_FORMATS].join(', ')} — legacy_alert is not permitted for Slack (got "${slackFormat}").`, code: 'INVALID_SLACK_FORMAT' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
