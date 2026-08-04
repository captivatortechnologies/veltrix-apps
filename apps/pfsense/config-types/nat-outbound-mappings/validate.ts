import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidNatTarget, isPortToken, isPortRangeToken, looksLikeInterfaceToken } from '../lib/pfsenseShared'
import { MAX_DESCRIPTION_LENGTH, PROTOCOLS, isValidMappingNetwork, portsApplicable, specFromItem } from './_shared'

function isValidPortField(value: string): boolean {
  return value === '' || isPortToken(value) || isPortRangeToken(value)
}

/**
 * Validate outbound-NAT-mapping items against pfSense's own rules
 * (schema-only, no live API calls — see lib/pfsenseApi.ts's module doc):
 *   - interface/source/destination required
 *   - source/destination shaped like a "network" value (no bare IP — see
 *     _shared.ts's isValidMappingNetwork); destination additionally allows "!"
 *   - target required unless nonat is enabled, shaped like a NAT target
 *   - target_subnet 1-128; ports shaped correctly when set; descr length-capped
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one outbound NAT mapping.', code: 'EMPTY' })
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

    if (spec.protocol && !PROTOCOLS.includes(spec.protocol)) {
      errors.push({ field: `${prefix}.protocol`, message: `"${spec.protocol}" is not a recognized protocol.`, code: 'INVALID_PROTOCOL' })
    }

    if (!spec.source) {
      errors.push({ field: `${prefix}.source`, message: 'Source is required.', code: 'EMPTY_SOURCE' })
    } else if (!isValidMappingNetwork(spec.source, { allowSelf: true })) {
      errors.push({ field: `${prefix}.source`, message: `"${spec.source}" is not a valid source — a subnet CIDR, existing alias, interface, "any", or "(self)" (not a bare IP).`, code: 'INVALID_SOURCE' })
    }

    if (!spec.destination) {
      errors.push({ field: `${prefix}.destination`, message: 'Destination is required.', code: 'EMPTY_DESTINATION' })
    } else if (!isValidMappingNetwork(spec.destination, { allowInvert: true })) {
      errors.push({ field: `${prefix}.destination`, message: `"${spec.destination}" is not a valid destination — a subnet CIDR, existing alias, interface, or "any" (not a bare IP).`, code: 'INVALID_DESTINATION' })
    }

    if (!spec.nonat) {
      if (!spec.target) {
        errors.push({ field: `${prefix}.target`, message: 'Target is required unless "No NAT" is enabled.', code: 'EMPTY_TARGET' })
      } else if (!isValidNatTarget(spec.target)) {
        errors.push({ field: `${prefix}.target`, message: `"${spec.target}" is not a valid target.`, code: 'INVALID_TARGET' })
      }
      if (spec.targetSubnet < 1 || spec.targetSubnet > 128) {
        errors.push({ field: `${prefix}.target_subnet`, message: 'Target Subnet Bits must be between 1 and 128.', code: 'INVALID_TARGET_SUBNET' })
      }
      if (!spec.staticNatPort && spec.natPort && !isValidPortField(spec.natPort)) {
        errors.push({ field: `${prefix}.nat_port`, message: `"${spec.natPort}" is not a valid port or port range.`, code: 'INVALID_NAT_PORT' })
      }
    } else if (spec.target) {
      warnings.push({ field: `${prefix}.target`, message: 'Target is ignored while "No NAT" is enabled.', code: 'TARGET_IGNORED' })
    }

    if (spec.sourcePort && !isValidPortField(spec.sourcePort)) {
      errors.push({ field: `${prefix}.source_port`, message: `"${spec.sourcePort}" is not a valid port or port range.`, code: 'INVALID_SOURCE_PORT' })
    }
    if (spec.destinationPort && !isValidPortField(spec.destinationPort)) {
      errors.push({ field: `${prefix}.destination_port`, message: `"${spec.destinationPort}" is not a valid port or port range.`, code: 'INVALID_DESTINATION_PORT' })
    }
    if ((spec.sourcePort || spec.destinationPort) && !portsApplicable(spec.protocol)) {
      warnings.push({ field: `${prefix}.destination_port`, message: 'Ports are ignored unless Protocol is TCP, UDP or TCP/UDP.', code: 'PORT_IGNORED' })
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
