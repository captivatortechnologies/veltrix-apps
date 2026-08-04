import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NOTIFICATION_CHANNEL_TYPES, splitList } from './_shared'

/**
 * Validate notification-channel items: a non-empty unique name, a known type,
 * and the fields that type requires. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one notification channel.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const p = (field: string) => `items[${i}].${field}`

    if (!name) {
      errors.push({ field: p('name'), message: 'Channel name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: p('name'), message: `Channel name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!NOTIFICATION_CHANNEL_TYPES.has(type)) {
      errors.push({ field: p('type'), message: `Type must be one of ${[...NOTIFICATION_CHANNEL_TYPES].join(', ')} (got "${type}").`, code: 'INVALID_TYPE' })
      return
    }

    switch (type) {
      case 'EMAIL':
        if (splitList(item.fields.emailRecipients).length === 0) {
          errors.push({ field: p('emailRecipients'), message: 'At least one email recipient is required.', code: 'EMPTY_RECIPIENTS' })
        }
        break
      case 'SLACK':
        if (!String(item.fields.url ?? '').trim()) errors.push({ field: p('url'), message: 'Slack webhook URL is required.', code: 'EMPTY_URL' })
        if (!String(item.fields.channel ?? '').trim()) errors.push({ field: p('channel'), message: 'Slack channel is required.', code: 'EMPTY_CHANNEL' })
        break
      case 'WEBHOOK':
      case 'PROMETHEUS_ALERT_MANAGER':
        if (!String(item.fields.url ?? '').trim()) errors.push({ field: p('url'), message: 'Destination URL is required.', code: 'EMPTY_URL' })
        break
      case 'PAGER_DUTY':
        if (!String(item.fields.account ?? '').trim()) errors.push({ field: p('account'), message: 'PagerDuty account is required.', code: 'EMPTY_ACCOUNT' })
        if (!String(item.fields.serviceKey ?? '').trim()) errors.push({ field: p('serviceKey'), message: 'PagerDuty service key is required.', code: 'EMPTY_SERVICE_KEY' })
        break
      case 'OPSGENIE':
      case 'MS_TEAMS':
        if (!String(item.fields.url ?? '').trim()) errors.push({ field: p('url'), message: 'Destination URL is required.', code: 'EMPTY_URL' })
        break
      case 'SNS':
        if (splitList(item.fields.snsTopicArns).length === 0) {
          errors.push({ field: p('snsTopicArns'), message: 'At least one SNS topic ARN is required.', code: 'EMPTY_TOPIC_ARNS' })
        }
        break
      case 'VICTOROPS':
        if (!String(item.fields.apiKey ?? '').trim()) errors.push({ field: p('apiKey'), message: 'VictorOps API key is required.', code: 'EMPTY_API_KEY' })
        if (!String(item.fields.routingKey ?? '').trim()) errors.push({ field: p('routingKey'), message: 'VictorOps routing key is required.', code: 'EMPTY_ROUTING_KEY' })
        break
      case 'TEAM_EMAIL':
        if (!Number.isFinite(Number(item.fields.teamId))) {
          errors.push({ field: p('teamId'), message: 'A numeric Team ID is required for a Team Email channel.', code: 'EMPTY_TEAM_ID' })
        }
        break
      default:
        break
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
