import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  ALIAS_TYPES,
  MAX_DESCRIPTION_LENGTH,
  aliasKey,
  isValidAddressEntry,
  specFromItem,
  validateAliasName,
} from './_shared'

/**
 * Validate firewall-alias items against pfSense's own rules (schema-only, no
 * live API calls — see lib/pfsenseApi.ts's module doc for why: the dynamic
 * "reserved name" set depends on the box's configured interfaces, which is
 * flagged as a WARNING here rather than faked as a hard rule):
 *   - name: required, <=31 chars, [A-Za-z0-9_] only, not all-digits/underscores,
 *     not "port"/"pass", not starting with "pkg_", unique per canvas (exact,
 *     case-sensitive — see _shared.ts's aliasKey doc)
 *   - type: required, one of host/network/port
 *   - descr: <=1024 chars
 *   - address: each entry must be shaped correctly for `type`
 *   - detail: may not outnumber address (mirrors TOO_MANY_ALIAS_DETAILS)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one firewall alias.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    const nameCheck = validateAliasName(spec.name)
    if (!nameCheck.valid) {
      errors.push({ field: `${prefix}.name`, message: nameCheck.error!, code: 'INVALID_NAME' })
    } else {
      if (nameCheck.warning) {
        warnings.push({ field: `${prefix}.name`, message: nameCheck.warning, code: 'POSSIBLY_RESERVED_NAME' })
      }
      const key = aliasKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate alias name "${spec.name}" — each name may only be declared once per canvas.`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }

    if (!spec.type) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type is required and must be one of: ${ALIAS_TYPES.join(', ')}.`,
        code: 'INVALID_TYPE',
      })
    }

    if (spec.descr.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.descr`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.descr.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }

    if (spec.address.length === 0) {
      warnings.push({
        field: `${prefix}.address`,
        message: 'This alias has no addresses — it will be created as an empty placeholder.',
        code: 'EMPTY_ADDRESS_LIST',
      })
    } else if (spec.type) {
      spec.address.forEach((entry, j) => {
        if (!isValidAddressEntry(spec.type as 'host' | 'network' | 'port', entry)) {
          errors.push({
            field: `${prefix}.address[${j}]`,
            message: `"${entry}" is not a valid ${spec.type} address entry.`,
            code: 'INVALID_ADDRESS_ENTRY',
          })
        }
      })
    }

    if (spec.detail.length > spec.address.length) {
      errors.push({
        field: `${prefix}.detail`,
        message: `Cannot have more descriptions (${spec.detail.length}) than addresses (${spec.address.length}).`,
        code: 'TOO_MANY_DETAILS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
