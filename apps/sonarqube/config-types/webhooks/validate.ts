import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidWebhookUrl, scopeOf } from './_shared'

/**
 * Validate webhook items: a non-empty name and a valid http(s) URL. The name is the
 * upsert identity within a scope (project key, or blank for global), so a duplicate
 * name in the same scope is flagged (last one wins). Static — no target access required.
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
    const name = String(item.fields.name ?? '').trim()
    const url = String(item.fields.url ?? '').trim()
    const project = scopeOf(item.fields.project)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Webhook name is required.', code: 'EMPTY_NAME' })
    } else {
      const identity = `${project.toLowerCase()}::${name}`
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].name`, message: `Webhook "${name}" is listed more than once for the same scope; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(identity)
      }
    }

    if (!url) {
      errors.push({ field: `items[${i}].url`, message: 'Webhook URL is required.', code: 'EMPTY_URL' })
    } else if (!isValidWebhookUrl(url)) {
      errors.push({ field: `items[${i}].url`, message: `Webhook URL "${url}" must be a valid http(s) URL.`, code: 'INVALID_URL' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
