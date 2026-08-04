import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate the global-settings singleton: known yes/no choices, numeric
 * windows/percentages, and a destination URL wherever a webhook is enabled.
 * Static — no target access required. There should be exactly one item;
 * extras warn (only the first applies).
 */
const YES_NO = new Set(['yes', 'no', ''])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the global settings.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    warnings.push({ field: 'items', message: 'Global settings is a singleton; only the first item is applied.', code: 'SINGLETON' })
  }

  const fields = items[0].fields

  for (const key of ['enableAnalytics', 'aiFeaturesDisabled', 'enableHostUsers', 'enableSoftwareInventory', 'hostExpiryEnabled', 'activityExpiryEnabled']) {
    const value = String(fields[key] ?? '').trim().toLowerCase()
    if (!YES_NO.has(value)) {
      errors.push({ field: `items[0].${key}`, message: `${key} must be yes or no.`, code: 'INVALID_YES_NO' })
    }
  }

  const webhooks: Array<[string, string]> = [
    ['hostStatusWebhookEnabled', 'hostStatusWebhookUrl'],
    ['failingPoliciesWebhookEnabled', 'failingPoliciesWebhookUrl'],
    ['vulnerabilitiesWebhookEnabled', 'vulnerabilitiesWebhookUrl'],
    ['activitiesWebhookEnabled', 'activitiesWebhookUrl'],
  ]
  for (const [enabledKey, urlKey] of webhooks) {
    const enabled = String(fields[enabledKey] ?? '').trim().toLowerCase() === 'yes'
    const url = String(fields[urlKey] ?? '').trim()
    if (enabled && !url) {
      errors.push({ field: `items[0].${urlKey}`, message: `${urlKey} is required when ${enabledKey} is enabled.`, code: 'MISSING_WEBHOOK_URL' })
    } else if (enabled && !/^https?:\/\//i.test(url)) {
      warnings.push({ field: `items[0].${urlKey}`, message: `${urlKey} does not look like an http(s) URL.`, code: 'UNVERIFIED_URL' })
    }
  }

  const hostExpiryWindow = Number(fields.hostExpiryWindowDays)
  if (fields.hostExpiryWindowDays !== undefined && (!Number.isFinite(hostExpiryWindow) || hostExpiryWindow < 1)) {
    errors.push({ field: 'items[0].hostExpiryWindowDays', message: 'Host Expiry Window must be a positive number of days.', code: 'INVALID_WINDOW' })
  }
  const activityExpiryWindow = Number(fields.activityExpiryWindowDays)
  if (fields.activityExpiryWindowDays !== undefined && (!Number.isFinite(activityExpiryWindow) || activityExpiryWindow < 1)) {
    errors.push({ field: 'items[0].activityExpiryWindowDays', message: 'Activity Expiry Window must be a positive number of days.', code: 'INVALID_WINDOW' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
