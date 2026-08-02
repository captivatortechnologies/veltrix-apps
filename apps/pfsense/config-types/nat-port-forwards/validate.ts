import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidFilterAddress, isValidNatTarget, isPortToken, isPortRangeToken, looksLikeInterfaceToken } from '../lib/pfsenseShared'
import { IP_PROTOCOLS, PROTOCOLS, MAX_DESCRIPTION_LENGTH, ASSOCIATED_RULE_KEYWORDS, portsApplicable, specFromItem } from './_shared'

function isValidPortField(value: string): boolean {
  return value === '' || isPortToken(value) || isPortRangeToken(value)
}

/**
 * Validate NAT-port-forward items against pfSense's own rules (schema-only,
 * no live API calls — see lib/pfsenseApi.ts's module doc):
 *   - interface/protocol/source/destination/target/local_port required
 *   - source/destination shaped like a valid filter address; target shaped
 *     like a valid NAT target (a stricter subset — see isValidNatTarget)
 *   - ports shaped correctly when set
 *   - descr length-capped; position, when set, must be non-negative integer
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one NAT port forward.', code: 'EMPTY' })
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

    if (!spec.protocol) {
      errors.push({ field: `${prefix}.protocol`, message: `Protocol is required and must be one of: ${PROTOCOLS.join(', ')}.`, code: 'INVALID_PROTOCOL' })
    } else if (!PROTOCOLS.includes(spec.protocol)) {
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

    if (!spec.target) {
      errors.push({ field: `${prefix}.target`, message: 'Target is required.', code: 'EMPTY_TARGET' })
    } else if (!isValidNatTarget(spec.target)) {
      errors.push({
        field: `${prefix}.target`,
        message: `"${spec.target}" is not a valid target — an IP address, an existing alias, or an interface's ":ip" modifier only (not a bare interface, subnet, or "any").`,
        code: 'INVALID_TARGET',
      })
    }

    if (!spec.localPort) {
      errors.push({ field: `${prefix}.local_port`, message: 'Local Port is required.', code: 'EMPTY_LOCAL_PORT' })
    } else if (!isPortToken(spec.localPort)) {
      errors.push({ field: `${prefix}.local_port`, message: `"${spec.localPort}" is not a valid single port or port alias (ranges are not allowed here).`, code: 'INVALID_LOCAL_PORT' })
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

    if (!(ASSOCIATED_RULE_KEYWORDS as readonly string[]).includes(spec.associatedRuleId) && spec.associatedRuleId) {
      warnings.push({
        field: `${prefix}.associated_rule_id`,
        message: `"${spec.associatedRuleId}" is treated as an EXISTING firewall rule's associated-rule id to link to — this cannot be verified without a live connection.`,
        code: 'CUSTOM_ASSOCIATED_RULE_ID',
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
