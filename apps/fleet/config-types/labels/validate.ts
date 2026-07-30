import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PLATFORMS } from './_shared'

/**
 * Validate label items: a safe label name and a non-empty osquery SQL selector.
 * Static — no target access required. Description is optional; platform is
 * optional but, when supplied, must be a known choice.
 */
const NAME_RE = /^[A-Za-z0-9 ._:-]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one label.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const query = String(item.fields.query ?? '').trim()
    const platform = String(item.fields.platform ?? 'all').trim().toLowerCase()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Label name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Label name "${name}" may only contain letters, numbers, space, dot, underscore, colon or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Label ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!query) {
      errors.push({ field: `items[${i}].query`, message: 'Query (osquery SQL) is required.', code: 'EMPTY_QUERY' })
    }

    if (!PLATFORMS.has(platform)) {
      errors.push({ field: `items[${i}].platform`, message: `Platform must be one of all, linux, darwin, windows (got "${platform}").`, code: 'INVALID_PLATFORM' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
