import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE, POLICIES, PROTOCOLS, looksLikeKnownNetworkId, networkIdKey, parseRules } from './_shared'

/**
 * Validate L3 firewall ruleset item(s): a well-formed `network_id`, unique
 * across the canvas (last one wins otherwise — warned, not blocked, matching
 * the platform's other ordered-singleton config types), and a `rules` value
 * that parses to a JSON array of rule objects, each with a supported `policy`
 * and `protocol`. Static — no target access; `network_id` existing and being
 * an MX-capable (appliance) network is verified at deploy time by Meraki
 * itself (a 404/400 there surfaces a clear error).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one network firewall ruleset.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const networkId = String(item.fields.network_id ?? '').trim()
    const prefix = `items[${i}]`

    if (!networkId) {
      errors.push({ field: `${prefix}.network_id`, message: 'Meraki network id is required.', code: 'REQUIRED' })
    } else if (!NETWORK_ID_RE.test(networkId)) {
      errors.push({
        field: `${prefix}.network_id`,
        message: `Network id "${networkId}" may contain only letters, digits, underscore and hyphen.`,
        code: 'INVALID_NETWORK_ID',
      })
    } else {
      if (!looksLikeKnownNetworkId(networkId)) {
        warnings.push({
          field: `${prefix}.network_id`,
          message: `Network id "${networkId}" does not start with the usual "L_" or "N_" prefix — double-check it against the Meraki dashboard.`,
          code: 'UNUSUAL_NETWORK_ID',
        })
      }
      const key = networkIdKey(networkId)
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.network_id`,
          message: `Network "${networkId}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NETWORK_ID',
        })
      } else {
        seen.add(key)
      }
    }

    const { rules, error } = parseRules(item.fields.rules)
    if (error) {
      errors.push({ field: `${prefix}.rules`, message: error, code: 'INVALID_RULES' })
    } else if (rules) {
      if (rules.length === 0) {
        warnings.push({
          field: `${prefix}.rules`,
          message: `Network "${networkId || '(unnamed)'}" has no custom rules — only Meraki's implicit "allow any/any" Default rule will apply.`,
          code: 'EMPTY_RULES',
        })
      }
      rules.forEach((rule, ri) => {
        const rLabel = `${prefix}.rules[${ri}]`
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          errors.push({ field: rLabel, message: 'Each rule must be a JSON object.', code: 'INVALID_RULE' })
          return
        }
        const policy = typeof rule.policy === 'string' ? rule.policy.trim().toLowerCase() : ''
        const protocol = typeof rule.protocol === 'string' ? rule.protocol.trim().toLowerCase() : ''
        if (!POLICIES.includes(policy as (typeof POLICIES)[number])) {
          errors.push({
            field: `${rLabel}.policy`,
            message: `Rule ${ri} has an unsupported policy "${rule.policy}" — must be "allow" or "deny".`,
            code: 'INVALID_POLICY',
          })
        }
        if (!PROTOCOLS.includes(protocol as (typeof PROTOCOLS)[number])) {
          errors.push({
            field: `${rLabel}.protocol`,
            message: `Rule ${ri} has an unsupported protocol "${rule.protocol}" — must be one of ${PROTOCOLS.join(', ')}.`,
            code: 'INVALID_PROTOCOL',
          })
        }
        if (!String(rule.comment ?? '').trim()) {
          warnings.push({ field: `${rLabel}.comment`, message: `Rule ${ri} has no comment.`, code: 'RULE_NO_COMMENT' })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
