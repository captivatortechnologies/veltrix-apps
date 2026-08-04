import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE } from '../../lib/merakiCommon'
import { extractOrderedListSpecs, parseOrderedListRules } from '../../lib/merakiOrderedList'
import { PORT_FORWARDING_PROTOCOLS, PORT_FORWARDING_UPLINKS, looksLikeKnownNetworkId, networkIdKey, type MerakiPortForwardingRule } from './_shared'

/**
 * Validate port forwarding ruleset item(s): a well-formed `network_id`,
 * unique across the canvas, and a `rules` value that parses to a JSON array
 * where every rule has the four required fields (`lanIp`, `uplink`,
 * `publicPort`, `localPort`), a supported `protocol`, and a non-empty
 * `allowedIps`. Static.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one port forwarding ruleset.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const networkId = String(item.fields.network_id ?? '').trim()
    const prefix = `items[${i}]`

    if (!networkId) {
      errors.push({ field: `${prefix}.network_id`, message: 'Meraki network id is required.', code: 'REQUIRED' })
    } else if (!NETWORK_ID_RE.test(networkId)) {
      errors.push({ field: `${prefix}.network_id`, message: `Network id "${networkId}" may contain only letters, digits, underscore and hyphen.`, code: 'INVALID_NETWORK_ID' })
    } else {
      if (!looksLikeKnownNetworkId(networkId)) {
        warnings.push({ field: `${prefix}.network_id`, message: `Network id "${networkId}" does not start with the usual "L_" or "N_" prefix — double-check it against the Meraki dashboard.`, code: 'UNUSUAL_NETWORK_ID' })
      }
      const key = networkIdKey(networkId)
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.network_id`, message: `Network "${networkId}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NETWORK_ID' })
      } else {
        seen.add(key)
      }
    }

    const { rules, error } = parseOrderedListRules<MerakiPortForwardingRule>(item.fields.rules)
    if (error) {
      errors.push({ field: `${prefix}.rules`, message: error, code: 'INVALID_RULES' })
      return
    }
    if (!rules) return

    if (rules.length === 0) {
      warnings.push({ field: `${prefix}.rules`, message: `Network "${networkId || '(unnamed)'}" has no port forwarding rules configured.`, code: 'EMPTY_RULES' })
    }

    rules.forEach((rule, ri) => {
      const rLabel = `${prefix}.rules[${ri}]`
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        errors.push({ field: rLabel, message: 'Each rule must be a JSON object.', code: 'INVALID_RULE' })
        return
      }
      for (const field of ['lanIp', 'publicPort', 'localPort'] as const) {
        if (!String(rule[field] ?? '').trim()) {
          errors.push({ field: `${rLabel}.${field}`, message: `Rule ${ri} requires ${field}.`, code: 'REQUIRED' })
        }
      }
      const uplink = typeof rule.uplink === 'string' ? rule.uplink.trim() : ''
      if (!uplink) {
        errors.push({ field: `${rLabel}.uplink`, message: `Rule ${ri} requires an uplink.`, code: 'REQUIRED' })
      } else if (!PORT_FORWARDING_UPLINKS.includes(uplink as (typeof PORT_FORWARDING_UPLINKS)[number])) {
        errors.push({ field: `${rLabel}.uplink`, message: `Rule ${ri} has an unsupported uplink "${rule.uplink}" — must be one of ${PORT_FORWARDING_UPLINKS.join(', ')}.`, code: 'INVALID_UPLINK' })
      }
      const protocol = typeof rule.protocol === 'string' ? rule.protocol.trim().toLowerCase() : ''
      if (!PORT_FORWARDING_PROTOCOLS.includes(protocol as (typeof PORT_FORWARDING_PROTOCOLS)[number])) {
        errors.push({ field: `${rLabel}.protocol`, message: `Rule ${ri} has an unsupported protocol "${rule.protocol}" — must be "tcp" or "udp".`, code: 'INVALID_PROTOCOL' })
      }
      if (!Array.isArray(rule.allowedIps) || rule.allowedIps.length === 0) {
        errors.push({ field: `${rLabel}.allowedIps`, message: `Rule ${ri} requires a non-empty allowedIps array (use ["any"] to allow all).`, code: 'REQUIRED' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
