import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PLATFORMS } from './_shared'

/**
 * Validate saved-query items: a safe query name, a non-empty osquery SQL body, a
 * non-negative interval, and a known platform / observer choice. Static — no
 * target access required. interval may arrive as number or string; coerce first.
 */
const NAME_RE = /^[A-Za-z0-9 ._:-]+$/
const OBSERVER_CHOICES = new Set(['yes', 'no'])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one saved query.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const query = String(item.fields.query ?? '').trim()
    const interval = Number(item.fields.interval)
    const platform = String(item.fields.platform ?? 'all').trim().toLowerCase()
    const observerCanRun = String(item.fields.observerCanRun ?? '').trim().toLowerCase()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Query name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Query name "${name}" may only contain letters, numbers, space, dot, underscore, colon or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Query ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!query) {
      errors.push({ field: `items[${i}].query`, message: 'Query (osquery SQL) is required.', code: 'EMPTY_QUERY' })
    }

    if (!Number.isFinite(interval) || interval < 0) {
      errors.push({ field: `items[${i}].interval`, message: 'Interval (seconds) must be a number greater than or equal to 0.', code: 'INVALID_INTERVAL' })
    }

    if (!PLATFORMS.has(platform)) {
      errors.push({ field: `items[${i}].platform`, message: `Platform must be one of all, linux, darwin, windows (got "${platform}").`, code: 'INVALID_PLATFORM' })
    }

    if (!OBSERVER_CHOICES.has(observerCanRun)) {
      errors.push({ field: `items[${i}].observerCanRun`, message: `Observer Can Run must be yes or no (got "${observerCanRun}").`, code: 'INVALID_OBSERVER' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
