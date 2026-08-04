import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE } from '../../lib/merakiCommon'
import { extractOrderedListSpecs, parseOrderedListRules } from '../../lib/merakiOrderedList'
import { NAT_INBOUND_PROTOCOLS, UPLINK_RE, looksLikeKnownNetworkId, networkIdKey, type MerakiOneToOneNatRule } from './_shared'

/**
 * Validate one-to-one NAT ruleset item(s): a well-formed `network_id`, unique
 * across the canvas, and a `rules` value that parses to a JSON array of rule
 * objects, each with a required `lanIp`, an uplink in the documented
 * "internetN" format when set, and well-formed `allowedInbound` entries.
 * Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one one-to-one NAT ruleset.', code: 'EMPTY' })
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

    const { rules, error } = parseOrderedListRules<MerakiOneToOneNatRule>(item.fields.rules)
    if (error) {
      errors.push({ field: `${prefix}.rules`, message: error, code: 'INVALID_RULES' })
      return
    }
    if (!rules) return

    if (rules.length === 0) {
      warnings.push({ field: `${prefix}.rules`, message: `Network "${networkId || '(unnamed)'}" has no one-to-one NAT rules configured.`, code: 'EMPTY_RULES' })
    }

    rules.forEach((rule, ri) => {
      const rLabel = `${prefix}.rules[${ri}]`
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        errors.push({ field: rLabel, message: 'Each rule must be a JSON object.', code: 'INVALID_RULE' })
        return
      }
      if (!String(rule.lanIp ?? '').trim()) {
        errors.push({ field: `${rLabel}.lanIp`, message: `Rule ${ri} requires a lanIp.`, code: 'REQUIRED' })
      }
      const uplink = typeof rule.uplink === 'string' ? rule.uplink.trim() : ''
      if (uplink && !UPLINK_RE.test(uplink)) {
        errors.push({ field: `${rLabel}.uplink`, message: `Rule ${ri} has an invalid uplink "${rule.uplink}" — expected the format "internetN" (e.g. internet1).`, code: 'INVALID_UPLINK' })
      }
      const allowedInbound = Array.isArray(rule.allowedInbound) ? rule.allowedInbound : []
      allowedInbound.forEach((ib, ii) => {
        const ibLabel = `${rLabel}.allowedInbound[${ii}]`
        const protocol = typeof ib?.protocol === 'string' ? ib.protocol.trim().toLowerCase() : ''
        if (!NAT_INBOUND_PROTOCOLS.includes(protocol as (typeof NAT_INBOUND_PROTOCOLS)[number])) {
          errors.push({ field: `${ibLabel}.protocol`, message: `Unsupported protocol "${ib?.protocol}" — must be one of ${NAT_INBOUND_PROTOCOLS.join(', ')}.`, code: 'INVALID_PROTOCOL' })
        }
      })
      if (rule.allowedInbound !== undefined && !Array.isArray(rule.allowedInbound)) {
        errors.push({ field: `${rLabel}.allowedInbound`, message: `Rule ${ri}'s allowedInbound must be an array.`, code: 'INVALID_ALLOWED_INBOUND' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
