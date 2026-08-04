import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE } from '../../lib/merakiCommon'
import { extractOrderedListSpecs, parseOrderedListRules } from '../../lib/merakiOrderedList'
import { PORT_RULE_PROTOCOLS, UPLINK_RE, looksLikeKnownNetworkId, networkIdKey, type MerakiOneToManyNatRule } from './_shared'

/**
 * Validate one-to-many NAT ruleset item(s): a well-formed `network_id`,
 * unique across the canvas, and a `rules` value that parses to a JSON array
 * where each rule has a `publicIp`, an "internetN" `uplink`, and well-formed
 * `portRules` (each with a required `protocol` in {tcp, udp}). Static.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one one-to-many NAT ruleset.', code: 'EMPTY' })
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

    const { rules, error } = parseOrderedListRules<MerakiOneToManyNatRule>(item.fields.rules)
    if (error) {
      errors.push({ field: `${prefix}.rules`, message: error, code: 'INVALID_RULES' })
      return
    }
    if (!rules) return

    if (rules.length === 0) {
      warnings.push({ field: `${prefix}.rules`, message: `Network "${networkId || '(unnamed)'}" has no one-to-many NAT rules configured.`, code: 'EMPTY_RULES' })
    }

    rules.forEach((rule, ri) => {
      const rLabel = `${prefix}.rules[${ri}]`
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        errors.push({ field: rLabel, message: 'Each rule must be a JSON object.', code: 'INVALID_RULE' })
        return
      }
      if (!String(rule.publicIp ?? '').trim()) {
        errors.push({ field: `${rLabel}.publicIp`, message: `Rule ${ri} requires a publicIp.`, code: 'REQUIRED' })
      }
      const uplink = typeof rule.uplink === 'string' ? rule.uplink.trim() : ''
      if (!uplink) {
        errors.push({ field: `${rLabel}.uplink`, message: `Rule ${ri} requires an uplink.`, code: 'REQUIRED' })
      } else if (!UPLINK_RE.test(uplink)) {
        errors.push({ field: `${rLabel}.uplink`, message: `Rule ${ri} has an invalid uplink "${rule.uplink}" — expected the format "internetN" (e.g. internet1).`, code: 'INVALID_UPLINK' })
      }

      const portRules = Array.isArray(rule.portRules) ? rule.portRules : null
      if (!portRules) {
        errors.push({ field: `${rLabel}.portRules`, message: `Rule ${ri} requires a portRules array.`, code: 'REQUIRED' })
        return
      }
      if (portRules.length === 0) {
        warnings.push({ field: `${rLabel}.portRules`, message: `Rule ${ri} has no port rules — no traffic will be forwarded for this public IP.`, code: 'EMPTY_PORT_RULES' })
      }
      portRules.forEach((pr, pi) => {
        const prLabel = `${rLabel}.portRules[${pi}]`
        const protocol = typeof pr?.protocol === 'string' ? pr.protocol.trim().toLowerCase() : ''
        if (!PORT_RULE_PROTOCOLS.includes(protocol as (typeof PORT_RULE_PROTOCOLS)[number])) {
          errors.push({ field: `${prLabel}.protocol`, message: `Port rule ${pi} has an unsupported protocol "${pr?.protocol}" — must be "tcp" or "udp".`, code: 'INVALID_PROTOCOL' })
        }
        if (!String(pr?.localIp ?? '').trim()) {
          errors.push({ field: `${prLabel}.localIp`, message: `Port rule ${pi} requires a localIp.`, code: 'REQUIRED' })
        }
      })
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
