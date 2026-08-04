import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidFilterAddress, isValidNatTarget, looksLikeInterfaceToken } from '../lib/pfsenseShared'
import { IP_PROTOCOLS, MAX_DESCRIPTION_LENGTH, specFromItem } from './_shared'

/**
 * Validate 1:1-NAT-mapping items against pfSense's own rules (schema-only,
 * no live API calls — an IP-family cross-check between `external`/`source`/
 * `destination` and `ipprotocol` is enforced server-side per-value, see
 * lib/pfsenseApi.ts's module doc):
 *   - interface/external/source/destination required
 *   - external shaped like a valid NAT target (IP/alias/interface:ip — no
 *     bare interface, subnet, or "any", same restriction as NAT port forwards)
 *   - source/destination shaped like a valid filter address
 *   - descr length-capped
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one 1:1 NAT mapping.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.interface) {
      errors.push({ field: `${prefix}.interface`, message: 'Interface is required.', code: 'EMPTY_INTERFACE' })
    } else if (!looksLikeInterfaceToken(spec.interface)) {
      errors.push({ field: `${prefix}.interface`, message: `"${spec.interface}" is not a valid interface value.`, code: 'INVALID_INTERFACE' })
    }

    if (!IP_PROTOCOLS.includes(spec.ipprotocol)) {
      errors.push({ field: `${prefix}.ipprotocol`, message: `IP Protocol must be one of: ${IP_PROTOCOLS.join(', ')}.`, code: 'INVALID_IPPROTOCOL' })
    }

    if (!spec.external) {
      errors.push({ field: `${prefix}.external`, message: 'External Address is required.', code: 'EMPTY_EXTERNAL' })
    } else if (!isValidNatTarget(spec.external)) {
      errors.push({
        field: `${prefix}.external`,
        message: `"${spec.external}" is not a valid external address — an IP address, an existing alias, or an interface's ":ip" modifier only.`,
        code: 'INVALID_EXTERNAL',
      })
    }

    if (!spec.source) {
      errors.push({ field: `${prefix}.source`, message: 'Source is required.', code: 'EMPTY_SOURCE' })
    } else if (!isValidFilterAddress(spec.source)) {
      errors.push({ field: `${prefix}.source`, message: `"${spec.source}" is not a valid source value.`, code: 'INVALID_SOURCE' })
    }

    if (!spec.destination) {
      errors.push({ field: `${prefix}.destination`, message: 'Destination is required.', code: 'EMPTY_DESTINATION' })
    } else if (!isValidFilterAddress(spec.destination)) {
      errors.push({ field: `${prefix}.destination`, message: `"${spec.destination}" is not a valid destination value.`, code: 'INVALID_DESTINATION' })
    }

    if (spec.descr.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.descr`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.descr.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    } else if (!spec.descr) {
      warnings.push({
        field: `${prefix}.descr`,
        message: 'No description set — a description makes this mapping far easier to recognize in the pfSense GUI and in drift/audit output.',
        code: 'MISSING_DESCRIPTION',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
