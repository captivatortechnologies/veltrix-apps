import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidIp, looksLikeInterfaceToken, looksLikeToken } from '../lib/pfsenseShared'
import { IP_PROTOCOLS, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, gatewayKey, specFromItem } from './_shared'

const NAME_CHARSET_RE = /^[A-Za-z0-9_]+$/
const ALL_DIGITS_RE = /^\d+$/

/**
 * Validate gateway items against pfSense's own rules (schema-only, no live
 * API calls — an interface's actual IP-family match can only be verified
 * server-side, see lib/pfsenseApi.ts's module doc):
 *   - name required, <=31 chars, [A-Za-z0-9_] charset, not all-digits, unique per canvas
 *   - ipprotocol/interface/gateway required
 *   - gateway must be a valid IP of the declared family, or the literal "dynamic"
 *   - monitor, when set, must be a valid IP
 *   - weight 1-30
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one gateway.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer (got ${spec.name.length}).`, code: 'NAME_TOO_LONG' })
    } else if (ALL_DIGITS_RE.test(spec.name) || !NAME_CHARSET_RE.test(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: 'Name may only contain letters, numbers and underscores, and may not be purely numeric.', code: 'INVALID_NAME' })
    } else {
      const key = gatewayKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate gateway name "${spec.name}" — each name may only be declared once per canvas.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
    }

    if (!spec.ipprotocol) {
      errors.push({ field: `${prefix}.ipprotocol`, message: `IP Protocol is required and must be one of: ${IP_PROTOCOLS.join(', ')}.`, code: 'INVALID_IPPROTOCOL' })
    }

    if (!spec.interface) {
      errors.push({ field: `${prefix}.interface`, message: 'Interface is required.', code: 'EMPTY_INTERFACE' })
    } else if (!looksLikeInterfaceToken(spec.interface)) {
      errors.push({ field: `${prefix}.interface`, message: `"${spec.interface}" is not a valid interface value.`, code: 'INVALID_INTERFACE' })
    }

    if (!spec.gateway) {
      errors.push({ field: `${prefix}.gateway`, message: 'Gateway Address is required.', code: 'EMPTY_GATEWAY' })
    } else if (spec.gateway !== 'dynamic' && !isValidIp(spec.gateway)) {
      errors.push({ field: `${prefix}.gateway`, message: `"${spec.gateway}" is not a valid IP address or "dynamic".`, code: 'INVALID_GATEWAY' })
    } else if (spec.ipprotocol && spec.gateway !== 'dynamic') {
      const isV6 = spec.gateway.includes(':')
      if (spec.ipprotocol === 'inet' && isV6) {
        errors.push({ field: `${prefix}.gateway`, message: 'Gateway Address must be IPv4 when IP Protocol is IPv4.', code: 'GATEWAY_IP_FAMILY_MISMATCH' })
      } else if (spec.ipprotocol === 'inet6' && !isV6) {
        errors.push({ field: `${prefix}.gateway`, message: 'Gateway Address must be IPv6 when IP Protocol is IPv6.', code: 'GATEWAY_IP_FAMILY_MISMATCH' })
      }
    }

    if (!spec.monitorDisable && spec.monitor && !isValidIp(spec.monitor)) {
      errors.push({ field: `${prefix}.monitor`, message: `"${spec.monitor}" is not a valid IP address.`, code: 'INVALID_MONITOR' })
    }
    if (spec.monitorDisable && spec.monitor) {
      warnings.push({ field: `${prefix}.monitor`, message: 'Monitor IP is ignored while monitoring is disabled.', code: 'MONITOR_IGNORED' })
    }

    if (spec.weight < 1 || spec.weight > 30) {
      errors.push({ field: `${prefix}.weight`, message: 'Weight must be between 1 and 30.', code: 'INVALID_WEIGHT' })
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
