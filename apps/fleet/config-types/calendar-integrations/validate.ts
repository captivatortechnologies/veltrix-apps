import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate calendar-integration items: a numeric team id, a known yes/no
 * toggle, and a webhook URL whenever the toggle is enabled. Static — no
 * target access required.
 */
const TEAM_ID_RE = /^[0-9]+$/
const YES_NO = new Set(['yes', 'no'])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one team\'s calendar integration.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const teamId = String(item.fields.teamId ?? '').trim()
    const enableCalendarEvents = String(item.fields.enableCalendarEvents ?? '').trim().toLowerCase()
    const webhookUrl = String(item.fields.webhookUrl ?? '').trim()

    if (!TEAM_ID_RE.test(teamId)) {
      errors.push({ field: `items[${i}].teamId`, message: 'Team ID is required and must be numeric.', code: 'INVALID_TEAM_ID' })
    } else if (seen.has(teamId)) {
      warnings.push({ field: `items[${i}].teamId`, message: `Team ${teamId} is listed more than once; the last one wins.`, code: 'DUPLICATE_TEAM' })
    } else {
      seen.add(teamId)
    }

    if (!YES_NO.has(enableCalendarEvents)) {
      errors.push({ field: `items[${i}].enableCalendarEvents`, message: 'Enable Calendar Events must be yes or no.', code: 'INVALID_YES_NO' })
    } else if (enableCalendarEvents === 'yes') {
      if (!webhookUrl) {
        errors.push({ field: `items[${i}].webhookUrl`, message: 'Webhook URL is required when Enable Calendar Events is Yes.', code: 'MISSING_WEBHOOK_URL' })
      } else if (!/^https?:\/\//i.test(webhookUrl)) {
        warnings.push({ field: `items[${i}].webhookUrl`, message: 'Webhook URL does not look like an http(s) URL.', code: 'UNVERIFIED_URL' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
