import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/** A lenient IPv4/IPv6 address or CIDR-range check — Secret Server does the authoritative validation. */
const RANGE_RE = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/

/**
 * Validate IP address restriction items: a non-empty name (its identity) and
 * a non-empty, plausibly-shaped CIDR/IP range. Static — no target access
 * required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one IP address restriction.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = item.fields ?? {}
    const name = String(f.name ?? '').trim()
    const range = String(f.range ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 255) {
      errors.push({ field: `items[${i}].name`, message: `Name "${name}" exceeds 255 characters.`, code: 'NAME_TOO_LONG' })
    }

    if (!range) {
      errors.push({ field: `items[${i}].range`, message: 'IP range is required.', code: 'EMPTY_RANGE' })
    } else if (!RANGE_RE.test(range)) {
      errors.push({
        field: `items[${i}].range`,
        message: `"${range}" does not look like a CIDR range or IP address.`,
        code: 'INVALID_RANGE',
      })
    }

    if (name) {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `IP address restriction "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_RESTRICTION',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
