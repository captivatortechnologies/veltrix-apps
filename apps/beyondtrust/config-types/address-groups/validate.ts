import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { declaredAddresses, str } from './_shared'

/** Loose charset check for an IPAddress entry — Password Safe accepts a single
 * IP, a CIDR/range, or a comma-delimited list of IPs in one value, so this only
 * rejects entries that clearly aren't any of those (free text, URLs, etc.). */
const ADDRESS_CHARSET_RE = /^[0-9a-fA-F.:,\-/]+$/

/**
 * Validate address-group items: a non-empty name within Password Safe's length
 * limit, and — for each declared address — a plausible IP/CIDR/range/CSV
 * charset. Static — no target access required. The name is the identity, so a
 * duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one address group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = str(item.fields.name)
    const addresses = declaredAddresses(item.fields.addresses)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Address group name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 256) {
      errors.push({ field: `items[${i}].name`, message: 'Address group name must be 256 characters or fewer.', code: 'NAME_TOO_LONG' })
    }

    addresses.forEach((addr, ai) => {
      if (!ADDRESS_CHARSET_RE.test(addr)) {
        errors.push({
          field: `items[${i}].addresses[${ai}]`,
          message: `"${addr}" does not look like an IP address, CIDR/range or comma-delimited IP list.`,
          code: 'INVALID_ADDRESS',
        })
      }
    })

    if (addresses.length === 0) {
      warnings.push({ field: `items[${i}].addresses`, message: `Address group ${name || `#${i}`} has no addresses — it will be created empty.`, code: 'EMPTY_ADDRESSES' })
    }

    if (name) {
      const identity = name.toLowerCase()
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].name`, message: `Address group ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_GROUP' })
      } else {
        seen.add(identity)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
