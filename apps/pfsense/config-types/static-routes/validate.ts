import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidCidr, looksLikeToken } from '../lib/pfsenseShared'
import { MAX_DESCRIPTION_LENGTH, specFromItem } from './_shared'

/**
 * Validate static-route items against pfSense's own rules (schema-only, no
 * live API calls — a gateway's existence/IP-family match can only be
 * verified server-side, see lib/pfsenseApi.ts's module doc):
 *   - network required: a CIDR subnet, or an alias-shaped token (existing alias)
 *   - gateway required: an alias-shaped token (existing RoutingGateway/-Group name)
 *   - descr length-capped
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one static route.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.network) {
      errors.push({ field: `${prefix}.network`, message: 'Destination Network is required.', code: 'EMPTY_NETWORK' })
    } else if (!isValidCidr(spec.network) && !looksLikeToken(spec.network)) {
      errors.push({ field: `${prefix}.network`, message: `"${spec.network}" is not a valid CIDR or alias name.`, code: 'INVALID_NETWORK' })
    }

    if (!spec.gateway) {
      errors.push({ field: `${prefix}.gateway`, message: 'Gateway is required.', code: 'EMPTY_GATEWAY' })
    } else if (!looksLikeToken(spec.gateway, 31)) {
      errors.push({ field: `${prefix}.gateway`, message: `"${spec.gateway}" is not a valid gateway name.`, code: 'INVALID_GATEWAY' })
    }

    if (spec.descr.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.descr`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.descr.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
