import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeEntry } from './_shared'

/**
 * Validate watched-entry items: a non-empty, well-formed entry (domain / IP /
 * hostname — no scheme, no whitespace, no path), a non-empty source, and a
 * description within Darktrace's 256-char limit. Static — no target access.
 * The (entry, source) pair is the identity, so a duplicate pair is flagged.
 */
const ENTRY_RE = /^[A-Za-z0-9._:*-]+$/
const MAX_DESCRIPTION = 256
const MAX_SOURCE = 64

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one watched entry.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const entry = normalizeEntry(item.fields.entry)
    const source = String(item.fields.source ?? '').trim()
    const description = String(item.fields.description ?? '').trim()

    if (!entry) {
      errors.push({ field: `items[${i}].entry`, message: 'Entry (domain / IP / hostname) is required.', code: 'EMPTY_ENTRY' })
    } else if (/^[a-z]+:\/\//i.test(entry) || /\s/.test(entry) || entry.includes('/')) {
      errors.push({ field: `items[${i}].entry`, message: `Entry "${entry}" must be a bare domain, IP or hostname — no scheme, path or spaces.`, code: 'INVALID_ENTRY' })
    } else if (!ENTRY_RE.test(entry)) {
      errors.push({ field: `items[${i}].entry`, message: `Entry "${entry}" has invalid characters for a domain / IP / hostname.`, code: 'INVALID_ENTRY' })
    }

    if (!source) {
      errors.push({ field: `items[${i}].source`, message: 'Source (watched list) is required.', code: 'EMPTY_SOURCE' })
    } else if (source.length > MAX_SOURCE) {
      errors.push({ field: `items[${i}].source`, message: `Source must be at most ${MAX_SOURCE} characters.`, code: 'SOURCE_TOO_LONG' })
    }

    if (description.length > MAX_DESCRIPTION) {
      errors.push({ field: `items[${i}].description`, message: `Description must be at most ${MAX_DESCRIPTION} characters.`, code: 'DESCRIPTION_TOO_LONG' })
    }

    if (entry) {
      const key = `${entry.toLowerCase()}|${source.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].entry`, message: `Entry "${entry}" is listed more than once for source "${source}"; the last one wins.`, code: 'DUPLICATE_ENTRY' })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
