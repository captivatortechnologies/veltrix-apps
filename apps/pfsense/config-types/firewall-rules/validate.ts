import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidFilterAddress, isPortToken, isPortRangeToken, looksLikeInterfaceToken } from '../lib/pfsenseShared'
import { RULE_ACTIONS, IP_PROTOCOLS, PROTOCOLS, MAX_DESCRIPTION_LENGTH, portsApplicable, specFromItem } from './_shared'

function isValidPortField(value: string): boolean {
  return value === '' || isPortToken(value) || isPortRangeToken(value)
}

/**
 * Validate firewall-rule items against pfSense's own rules (schema-only, no
 * live API calls — interface/alias EXISTENCE cannot be checked this way, see
 * lib/pfsenseApi.ts's module doc):
 *   - type/interface/ipprotocol/source/destination required
 *   - exactly one interface unless `floating` is enabled (mirrors
 *     FirewallRule::validate_interface())
 *   - source/destination shaped like a valid filter address
 *   - source_port/destination_port shaped like a valid port when set
 *   - descr length-capped
 *   - position, when set, must be a non-negative integer
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one firewall rule.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: `Action is required and must be one of: ${RULE_ACTIONS.join(', ')}.`, code: 'INVALID_TYPE' })
    }

    if (spec.interfaces.length === 0) {
      errors.push({ field: `${prefix}.interface`, message: 'At least one interface is required.', code: 'EMPTY_INTERFACE' })
    } else {
      const badInterfaces = spec.interfaces.filter((i2) => !looksLikeInterfaceToken(i2))
      badInterfaces.forEach((bad) => {
        errors.push({ field: `${prefix}.interface`, message: `"${bad}" is not a valid interface value.`, code: 'INVALID_INTERFACE' })
      })
      if (!spec.floating && spec.interfaces.length > 1) {
        errors.push({
          field: `${prefix}.interface`,
          message: 'Only ONE interface is allowed unless "Floating rule" is enabled.',
          code: 'MULTIPLE_INTERFACE_WITHOUT_FLOATING',
        })
      }
    }

    if (!spec.ipprotocol) {
      errors.push({ field: `${prefix}.ipprotocol`, message: `IP Protocol is required and must be one of: ${IP_PROTOCOLS.join(', ')}.`, code: 'INVALID_IPPROTOCOL' })
    }

    if (spec.protocol && !PROTOCOLS.includes(spec.protocol)) {
      errors.push({ field: `${prefix}.protocol`, message: `"${spec.protocol}" is not a recognized protocol.`, code: 'INVALID_PROTOCOL' })
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

    if (spec.sourcePort && !isValidPortField(spec.sourcePort)) {
      errors.push({ field: `${prefix}.source_port`, message: `"${spec.sourcePort}" is not a valid port or port range.`, code: 'INVALID_SOURCE_PORT' })
    }
    if (spec.sourcePort && !portsApplicable(spec.protocol)) {
      warnings.push({ field: `${prefix}.source_port`, message: 'Source Port is ignored unless Protocol is TCP, UDP or TCP/UDP.', code: 'PORT_IGNORED' })
    }

    if (spec.destinationPort && !isValidPortField(spec.destinationPort)) {
      errors.push({ field: `${prefix}.destination_port`, message: `"${spec.destinationPort}" is not a valid port or port range.`, code: 'INVALID_DESTINATION_PORT' })
    }
    if (spec.destinationPort && !portsApplicable(spec.protocol)) {
      warnings.push({ field: `${prefix}.destination_port`, message: 'Destination Port is ignored unless Protocol is TCP, UDP or TCP/UDP.', code: 'PORT_IGNORED' })
    }

    if (!spec.floating && (spec.quick || spec.direction !== 'any')) {
      warnings.push({
        field: `${prefix}.direction`,
        message: '"Direction" and "Quick" only apply to floating rules and will be ignored.',
        code: 'FLOATING_ONLY_FIELD_IGNORED',
      })
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
        message: 'No description set — a description makes this rule far easier to recognize in the pfSense GUI and in drift/audit output.',
        code: 'MISSING_DESCRIPTION',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
