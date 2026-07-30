import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SOURCE_FORMATS } from './_shared'

/**
 * Validate threat-feed items: a non-empty name, a non-empty http(s) URL and a
 * known source format. Static — no target access required. Feed URLs double as
 * the feed identity, so a duplicate URL is flagged (last one wins).
 */
const URL_RE = /^https?:\/\/.+/i

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one threat feed.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const url = String(item.fields.url ?? '').trim()
    const sourceFormat = String(item.fields.sourceFormat ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Feed name is required.', code: 'EMPTY_NAME' })
    }

    if (!url) {
      errors.push({ field: `items[${i}].url`, message: 'Feed URL is required.', code: 'EMPTY_URL' })
    } else if (!URL_RE.test(url)) {
      errors.push({ field: `items[${i}].url`, message: `Feed URL "${url}" must be an http(s) URL.`, code: 'INVALID_URL' })
    } else if (seen.has(url)) {
      warnings.push({ field: `items[${i}].url`, message: `Feed URL ${url} is listed more than once; the last one wins.`, code: 'DUPLICATE_URL' })
    } else {
      seen.add(url)
    }

    if (!SOURCE_FORMATS.has(sourceFormat)) {
      errors.push({ field: `items[${i}].sourceFormat`, message: `Source format must be one of misp, csv, freetext (got "${sourceFormat}").`, code: 'INVALID_SOURCE_FORMAT' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
