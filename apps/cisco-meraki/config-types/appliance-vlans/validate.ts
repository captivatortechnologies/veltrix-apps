import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE, looksLikeKnownNetworkId } from '../../lib/merakiCommon'
import { DHCP_HANDLING_VALUES, DHCP_LEASE_TIME_VALUES, extractVlanSpecs, isValidVlanId, networkIdKey, parseJsonObject } from './_shared'

/**
 * Validate VLAN item(s): a well-formed `network_id`, a VLAN `id` in [1, 4094]
 * unique per network, a required `name`, the documented `dhcp_handling` /
 * `dhcp_lease_time` enums when set, DHCP relay IPs only when relaying, boot
 * options only when enabled, and an `advanced` value that parses to a JSON
 * object. Static — no target access; whether VLANs are actually ENABLED on
 * the network is a live precondition checked at deploy time (see deploy.ts /
 * README "Known limitations").
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one VLAN.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractVlanSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.networkId) {
      errors.push({ field: `${prefix}.network_id`, message: 'Meraki network id is required.', code: 'REQUIRED' })
    } else if (!NETWORK_ID_RE.test(spec.networkId)) {
      errors.push({
        field: `${prefix}.network_id`,
        message: `Network id "${spec.networkId}" may contain only letters, digits, underscore and hyphen.`,
        code: 'INVALID_NETWORK_ID',
      })
    } else if (!looksLikeKnownNetworkId(spec.networkId)) {
      warnings.push({
        field: `${prefix}.network_id`,
        message: `Network id "${spec.networkId}" does not start with the usual "L_" or "N_" prefix — double-check it against the Meraki dashboard.`,
        code: 'UNUSUAL_NETWORK_ID',
      })
    }

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'VLAN id is required.', code: 'REQUIRED' })
    } else if (!isValidVlanId(spec.id)) {
      errors.push({ field: `${prefix}.id`, message: `VLAN id "${spec.id}" must be an integer between 1 and 4094.`, code: 'INVALID_VLAN_ID' })
    } else if (spec.networkId) {
      const key = `${networkIdKey(spec.networkId)}::${spec.id}`
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.id`,
          message: `VLAN ${spec.id} is listed more than once in network "${spec.networkId}"; the last one wins.`,
          code: 'DUPLICATE_VLAN_ID',
        })
      } else {
        seen.add(key)
      }
    }

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'VLAN name is required.', code: 'REQUIRED' })
    }

    if (spec.dhcpHandling && !DHCP_HANDLING_VALUES.includes(spec.dhcpHandling as (typeof DHCP_HANDLING_VALUES)[number])) {
      errors.push({
        field: `${prefix}.dhcp_handling`,
        message: `Unsupported DHCP handling "${spec.dhcpHandling}" — must be one of ${DHCP_HANDLING_VALUES.join(', ')}.`,
        code: 'INVALID_DHCP_HANDLING',
      })
    }
    if (spec.dhcpLeaseTime && !DHCP_LEASE_TIME_VALUES.includes(spec.dhcpLeaseTime as (typeof DHCP_LEASE_TIME_VALUES)[number])) {
      errors.push({
        field: `${prefix}.dhcp_lease_time`,
        message: `Unsupported DHCP lease time "${spec.dhcpLeaseTime}" — must be one of ${DHCP_LEASE_TIME_VALUES.join(', ')}.`,
        code: 'INVALID_DHCP_LEASE_TIME',
      })
    }
    if (spec.dhcpRelayServerIps.length > 0 && spec.dhcpHandling && spec.dhcpHandling !== 'Relay DHCP to another server') {
      warnings.push({
        field: `${prefix}.dhcp_relay_server_ips`,
        message: 'DHCP relay server IPs are set but DHCP Handling is not "Relay DHCP to another server" — Meraki will ignore them.',
        code: 'UNUSED_DHCP_RELAY_IPS',
      })
    }
    if (spec.dhcpHandling === 'Relay DHCP to another server' && spec.dhcpRelayServerIps.length === 0) {
      errors.push({
        field: `${prefix}.dhcp_relay_server_ips`,
        message: 'DHCP Handling is "Relay DHCP to another server" but no relay server IPs are set.',
        code: 'REQUIRED',
      })
    }
    if (!spec.dhcpBootOptionsEnabled && (spec.dhcpBootNextServer || spec.dhcpBootFilename)) {
      warnings.push({
        field: `${prefix}.dhcp_boot_options_enabled`,
        message: 'DHCP boot next-server/filename are set but "Enable DHCP Boot Options" is off — Meraki will ignore them.',
        code: 'UNUSED_DHCP_BOOT_OPTIONS',
      })
    }

    const { error } = parseJsonObject(spec.advancedRaw, 'advanced')
    if (error) errors.push({ field: `${prefix}.advanced`, message: error, code: 'INVALID_ADVANCED' })
  })

  return { valid: errors.length === 0, errors, warnings }
}
