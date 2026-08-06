import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractNotificationSettingsSpecs, notificationSettingsKey, parseNotificationsSettings } from './_shared'

/**
 * Validate notification settings declaration(s): unique accountId (including
 * multiple blank declarations, which all mean "the API key's own account"),
 * deleteAfter within GravityZone's documented 1-365 day range, and
 * parseable JSON for the notification types array. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one notification settings declaration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNotificationSettingsSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    const key = notificationSettingsKey(spec.accountId)
    if (seen.has(key)) {
      warnings.push({
        field: `${prefix}.accountId`,
        message: spec.accountId
          ? `Account "${spec.accountId}" is declared more than once; the last one wins.`
          : "More than one declaration leaves Account ID blank (the API key's own account); the last one wins.",
        code: 'DUPLICATE_ACCOUNT',
      })
    } else {
      seen.add(key)
    }

    if (spec.deleteAfter !== undefined && (spec.deleteAfter < 1 || spec.deleteAfter > 365)) {
      errors.push({
        field: `${prefix}.deleteAfter`,
        message: `Delete After (${spec.deleteAfter}) must be between 1 and 365 days.`,
        code: 'OUT_OF_RANGE',
      })
    }

    if (spec.notificationsSettingsRaw) {
      const { error } = parseNotificationsSettings(spec)
      if (error) errors.push({ field: `${prefix}.notificationsSettings`, message: error, code: 'INVALID_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
