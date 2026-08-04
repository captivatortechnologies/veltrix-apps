import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonObject, readOptionalString } from '../../lib/fields'

/**
 * Validate the Auth0 Attack Protection singleton: at most one declared item,
 * and — for each of the three sub-resource fields left non-blank — well-formed
 * JSON. A blank field is not validated further: it means "leave that
 * sub-resource untouched" and deploy.ts never calls the API for it. Static: no
 * target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the Attack Protection item.', code: 'EMPTY' })
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Attack Protection is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  items.forEach((item, i) => {
    if (readOptionalString(item.fields.breached_password_detection) !== undefined) {
      const parsed = parseJsonObject(item.fields.breached_password_detection)
      if (!parsed.ok) {
        errors.push({
          field: `items[${i}].breached_password_detection`,
          message: `Breached Password Detection ${parsed.error}.`,
          code: 'INVALID_BREACHED_PASSWORD_DETECTION',
        })
      }
    }

    if (readOptionalString(item.fields.brute_force_protection) !== undefined) {
      const parsed = parseJsonObject(item.fields.brute_force_protection)
      if (!parsed.ok) {
        errors.push({
          field: `items[${i}].brute_force_protection`,
          message: `Brute Force Protection ${parsed.error}.`,
          code: 'INVALID_BRUTE_FORCE_PROTECTION',
        })
      }
    }

    if (readOptionalString(item.fields.suspicious_ip_throttling) !== undefined) {
      const parsed = parseJsonObject(item.fields.suspicious_ip_throttling)
      if (!parsed.ok) {
        errors.push({
          field: `items[${i}].suspicious_ip_throttling`,
          message: `Suspicious IP Throttling ${parsed.error}.`,
          code: 'INVALID_SUSPICIOUS_IP_THROTTLING',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
