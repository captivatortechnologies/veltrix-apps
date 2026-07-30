import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PLATFORMS } from './_shared'

/**
 * Validate global-policy items: a safe policy name, a non-empty osquery SQL
 * check, and a known platform / critical choice. Static — no target access
 * required. Description and resolution are optional.
 */
const NAME_RE = /^[A-Za-z0-9 ._:-]+$/
const CRITICAL_CHOICES = new Set(['yes', 'no'])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one global policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const query = String(item.fields.query ?? '').trim()
    const platform = String(item.fields.platform ?? 'all').trim().toLowerCase()
    const critical = String(item.fields.critical ?? '').trim().toLowerCase()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Policy name "${name}" may only contain letters, numbers, space, dot, underscore, colon or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Policy ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!query) {
      errors.push({ field: `items[${i}].query`, message: 'Query (osquery SQL) is required.', code: 'EMPTY_QUERY' })
    }

    if (!PLATFORMS.has(platform)) {
      errors.push({ field: `items[${i}].platform`, message: `Platform must be one of all, linux, darwin, windows (got "${platform}").`, code: 'INVALID_PLATFORM' })
    }

    if (!CRITICAL_CHOICES.has(critical)) {
      errors.push({ field: `items[${i}].critical`, message: `Critical must be yes or no (got "${critical}").`, code: 'INVALID_CRITICAL' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
