import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem, CONTENT_TYPES, INSECURE_SSL_VALUES } from './_shared'

/**
 * Validate org-webhooks items: a non-empty org + a well-formed http(s) URL,
 * valid enums, and a warning for insecure SSL verification. Static — no
 * target access required. (org, url) is the identity, so a duplicate is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one webhook.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)

    if (!desired.org) {
      errors.push({ field: `items[${i}].org`, message: 'Organization is required.', code: 'EMPTY_ORG' })
    }
    if (!desired.url) {
      errors.push({ field: `items[${i}].url`, message: 'Payload URL is required.', code: 'EMPTY_URL' })
    } else if (!/^https?:\/\/.+/i.test(desired.url)) {
      errors.push({ field: `items[${i}].url`, message: 'Payload URL must start with http:// or https://.', code: 'INVALID_URL' })
    }

    if (desired.org && desired.url) {
      const key = `${desired.org.toLowerCase()}::${desired.url.trim().toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].url`,
          message: `Webhook ${desired.url} on ${desired.org} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_WEBHOOK',
        })
      } else {
        seen.add(key)
      }
    }

    if (!CONTENT_TYPES.includes(desired.contentType as (typeof CONTENT_TYPES)[number])) {
      errors.push({ field: `items[${i}].content_type`, message: `Content type must be one of ${CONTENT_TYPES.join(', ')}.`, code: 'INVALID_CONTENT_TYPE' })
    }
    if (!INSECURE_SSL_VALUES.includes(desired.insecureSsl as (typeof INSECURE_SSL_VALUES)[number])) {
      errors.push({ field: `items[${i}].insecure_ssl`, message: `SSL verification must be one of ${INSECURE_SSL_VALUES.join(', ')}.`, code: 'INVALID_INSECURE_SSL' })
    } else if (desired.insecureSsl === '1') {
      warnings.push({
        field: `items[${i}].insecure_ssl`,
        message: 'SSL verification is disabled for this webhook — GitHub will deliver events even if the target certificate is invalid.',
        code: 'SSL_VERIFICATION_DISABLED',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
