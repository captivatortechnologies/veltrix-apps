import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, isValidIPv4, specFromItem } from './_shared'

/**
 * Validate network device items: a non-empty, uniquely-named device with at
 * least one valid IPv4 address/mask (ERS rejects a device with no IP) within
 * ERS's length limits. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one network device.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const { name, description, ipEntries } = specFromItem(item)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Device name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `items[${i}].name`,
        message: `Device name must be ${MAX_NAME_LENGTH} characters or fewer (got ${name.length}).`,
        code: 'NAME_TOO_LONG',
      })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Device name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (ipEntries.length === 0) {
      errors.push({
        field: `items[${i}].ip_addresses`,
        message: 'At least one IP address is required — ISE rejects a network device with no IP.',
        code: 'EMPTY_IP_LIST',
      })
    } else {
      ipEntries.forEach((entry, e) => {
        if (!isValidIPv4(entry.ipaddress)) {
          errors.push({
            field: `items[${i}].ip_addresses[${e}]`,
            message: `"${entry.ipaddress}" is not a valid IPv4 address (IPv6 is not supported by this config type).`,
            code: 'INVALID_IPV4',
          })
        }
        if (entry.mask < 0 || entry.mask > 32) {
          errors.push({
            field: `items[${i}].ip_addresses[${e}]`,
            message: `Mask for "${entry.ipaddress}" must be between 0 and 32 (got ${entry.mask}).`,
            code: 'INVALID_MASK',
          })
        }
      })
    }

    if (description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
