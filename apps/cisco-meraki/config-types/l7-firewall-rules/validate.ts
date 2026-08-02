import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE } from '../../lib/merakiCommon'
import {
  L7_COUNTRY_TYPES,
  L7_OBJECT_VALUE_TYPES,
  L7_POLICIES,
  L7_STRING_VALUE_TYPES,
  L7_TYPES,
  looksLikeKnownNetworkId,
  networkIdKey,
  parseL7Rules,
} from './_shared'

/**
 * Validate L7 firewall ruleset item(s): a well-formed `network_id`, unique
 * across the canvas (last one wins, warned not blocked — matching l3's
 * convention), and a `rules` value that parses to a JSON array of rule
 * objects, each with `policy: "deny"`, a supported `type`, and a `value`
 * shaped correctly for that type. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one network L7 ruleset.', code: 'EMPTY' })
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

    const { rules, error } = parseL7Rules(item.fields.rules)
    if (error) {
      errors.push({ field: `${prefix}.rules`, message: error, code: 'INVALID_RULES' })
      return
    }
    if (!rules) return

    if (rules.length === 0) {
      warnings.push({
        field: `${prefix}.rules`,
        message: `Network "${networkId || '(unnamed)'}" has no L7 rules configured.`,
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
      const type = typeof rule.type === 'string' ? rule.type.trim() : ''

      if (!L7_POLICIES.includes(policy as (typeof L7_POLICIES)[number])) {
        errors.push({
          field: `${rLabel}.policy`,
          message: `Rule ${ri} has an unsupported policy "${rule.policy}" — Meraki L7 rules only support "deny".`,
          code: 'INVALID_POLICY',
        })
      }
      if (!L7_TYPES.includes(type as (typeof L7_TYPES)[number])) {
        errors.push({
          field: `${rLabel}.type`,
          message: `Rule ${ri} has an unsupported type "${rule.type}" — must be one of ${L7_TYPES.join(', ')}.`,
          code: 'INVALID_TYPE',
        })
        return
      }

      if (L7_STRING_VALUE_TYPES.has(type)) {
        if (typeof rule.value !== 'string' || !rule.value.trim()) {
          errors.push({ field: `${rLabel}.value`, message: `Rule ${ri} (type "${type}") requires a non-empty string value.`, code: 'INVALID_VALUE' })
        }
      } else if (L7_COUNTRY_TYPES.has(type)) {
        if (!Array.isArray(rule.value) || rule.value.length === 0 || !rule.value.every((v: unknown) => typeof v === 'string' && v.trim().length > 0)) {
          errors.push({
            field: `${rLabel}.value`,
            message: `Rule ${ri} (type "${type}") requires a non-empty array of ISO 3166-1 alpha-2 country codes.`,
            code: 'INVALID_VALUE',
          })
        }
      } else if (L7_OBJECT_VALUE_TYPES.has(type)) {
        // The exact object shape (an application/category id lookup) is UNVERIFIED
        // beyond "it's an object" — see README "Known limitations". Only the
        // coarse shape is checked here; Meraki itself validates the id.
        if (!rule.value || typeof rule.value !== 'object' || Array.isArray(rule.value)) {
          errors.push({
            field: `${rLabel}.value`,
            message: `Rule ${ri} (type "${type}") requires a value object referencing an application/category id (see the MX L7 application categories endpoint).`,
            code: 'INVALID_VALUE',
          })
        } else {
          warnings.push({
            field: `${rLabel}.value`,
            message: `Rule ${ri} (type "${type}"): the exact "value" object shape is not independently verified by this app — confirm it against the MX L7 application categories endpoint before relying on it.`,
            code: 'UNVERIFIED_VALUE_SHAPE',
          })
        }
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
