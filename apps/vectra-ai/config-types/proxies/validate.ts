import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate proxy items. Static — no target access required.
 *   - address is required and doubles as the proxy identity (duplicates warned).
 *   - address must be a valid IPv4 address or CIDR range (loose — Vectra is the
 *     final authority).
 */
const IP_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/

function isIpOrCidr(value: string): boolean {
  const m = IP_CIDR_RE.exec(value)
  if (!m) return false
  if ([m[1], m[2], m[3], m[4]].some((o) => Number(o) > 255)) return false
  if (m[5] && Number(m[5].slice(1)) > 32) return false
  return true
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one proxy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const address = String(item.fields.address ?? '').trim()

    if (!address) {
      errors.push({ field: `items[${i}].address`, message: 'Proxy address is required.', code: 'EMPTY_ADDRESS' })
    } else {
      if (seen.has(address)) {
        warnings.push({ field: `items[${i}].address`, message: `Proxy address "${address}" is listed more than once; the last one wins.`, code: 'DUPLICATE_ADDRESS' })
      } else {
        seen.add(address)
      }
      if (!isIpOrCidr(address)) {
        errors.push({ field: `items[${i}].address`, message: `"${address}" is not a valid IPv4 address or CIDR range.`, code: 'INVALID_ADDRESS' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
