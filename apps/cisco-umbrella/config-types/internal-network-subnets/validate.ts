import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  ASSOCIATION_TYPES,
  MAX_NAME_LENGTH,
  MAX_PREFIX,
  MIN_PREFIX,
  extractInternalNetworkSubnetSpecs,
  isAssociationType,
  isIpv4,
} from './_shared'

/**
 * Validate internal-network-subnet items: a unique non-empty name within the
 * length limit, a valid IPv4 address, a prefix length in 9–32 (Umbrella:
 * "must be greater than 8 and no more than 32"), a known association type, and
 * a non-empty association name. Static — whether the named Site/Network/Tunnel
 * actually exists is only checked at deploy/drift time (it requires a live
 * Umbrella lookup).
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractInternalNetworkSubnetSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one internal network subnet.', code: 'EMPTY' })
  }

  const seenNames = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate internal network subnet "${spec.name}" — each may only be declared once per canvas.`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (!spec.ipAddress) {
      errors.push({ field: `${prefix}.ipAddress`, message: 'IP address is required.', code: 'required' })
    } else if (!isIpv4(spec.ipAddress)) {
      errors.push({
        field: `${prefix}.ipAddress`,
        message: `"${spec.ipAddress}" is not a valid IPv4 address.`,
        code: 'invalid_ip',
      })
    }

    if (!Number.isInteger(spec.prefixLength) || spec.prefixLength < MIN_PREFIX || spec.prefixLength > MAX_PREFIX) {
      errors.push({
        field: `${prefix}.prefixLength`,
        message: `Prefix length must be an integer between ${MIN_PREFIX} and ${MAX_PREFIX} (got ${spec.prefixLength}).`,
        code: 'invalid_prefix',
      })
    }

    if (!isAssociationType(spec.associationType)) {
      errors.push({
        field: `${prefix}.associationType`,
        message: `Association type must be one of ${ASSOCIATION_TYPES.join(', ')} (got "${spec.associationType}").`,
        code: 'invalid_association_type',
      })
    }

    if (!spec.associationName) {
      errors.push({
        field: `${prefix}.associationName`,
        message: `The name of the ${spec.associationType} this subnet is tied to is required.`,
        code: 'required',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
