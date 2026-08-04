import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { buildNotificationEntity } from './_shared'

/**
 * Validate notification items: a non-empty title (the identity — a duplicate
 * is flagged, last one wins) and a well-formed `config` JSON object with a
 * `type` discriminator (e.g. "email-notification-v1", "http-notification-v2").
 * Static — no target access, so per-type required config keys (and, for
 * email, whether SMTP is configured in graylog.conf) surface at deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one notification.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = asString(item.fields.title)

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Notification title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Notification title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    const { error } = buildNotificationEntity(item.fields)
    if (error) {
      errors.push({ field: `items[${i}].config`, message: error, code: 'INVALID_CONFIG' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
