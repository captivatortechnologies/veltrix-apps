import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE, looksLikeKnownNetworkId, networkIdKey } from '../../lib/merakiCommon'
import { extractOrderedListSpecs, parseOrderedListRules } from '../../lib/merakiOrderedList'
import { ACL_IP_VERSIONS, ACL_POLICIES, ACL_PROTOCOLS, type MerakiSwitchAclRule } from './_shared'

/**
 * Validate switch ACL ruleset item(s): a well-formed `network_id`, unique
 * across the canvas, and a `rules` value that parses to a JSON array where
 * every rule has a supported `policy` (allow/deny) and `protocol`
 * (any/tcp/udp), an optional `ipVersion` (any/ipv4/ipv6) when set, and the
 * required `srcCidr`/`dstCidr`. An empty ruleset is flagged: unlike L3
 * firewall rules, Meraki documents that an empty `rules` array CLEARS all
 * switch ACLs rather than falling back to an implicit default rule. Static.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractOrderedListSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one switch ACL ruleset.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    const networkId = spec.networkId

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

    const { rules, error } = parseOrderedListRules<MerakiSwitchAclRule>(spec.rulesRaw)
    if (error) {
      errors.push({ field: `${prefix}.rules`, message: error, code: 'INVALID_RULES' })
      return
    }
    if (!rules) return

    if (rules.length === 0) {
      warnings.push({
        field: `${prefix}.rules`,
        message: `Network "${networkId || '(unnamed)'}" has an empty ACL — Meraki CLEARS all switch ACLs when the rules array is empty (unlike L3 firewall rules, there is no implicit default rule), so switch traffic on this network will be unrestricted by ACL.`,
        code: 'EMPTY_RULES_CLEARS_ACL',
      })
    }

    rules.forEach((rule, ri) => {
      const rLabel = `${prefix}.rules[${ri}]`
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        errors.push({ field: rLabel, message: 'Each rule must be a JSON object.', code: 'INVALID_RULE' })
        return
      }

      const policy = String(rule.policy ?? '').trim().toLowerCase()
      if (!ACL_POLICIES.includes(policy as (typeof ACL_POLICIES)[number])) {
        errors.push({ field: `${rLabel}.policy`, message: `Rule ${ri} has an unsupported policy "${rule.policy}" — must be "allow" or "deny".`, code: 'INVALID_POLICY' })
      }

      const protocol = String(rule.protocol ?? '').trim().toLowerCase()
      if (!ACL_PROTOCOLS.includes(protocol as (typeof ACL_PROTOCOLS)[number])) {
        errors.push({ field: `${rLabel}.protocol`, message: `Rule ${ri} has an unsupported protocol "${rule.protocol}" — must be one of ${ACL_PROTOCOLS.join(', ')}.`, code: 'INVALID_PROTOCOL' })
      }

      const ipVersion = rule.ipVersion === undefined ? 'any' : String(rule.ipVersion).trim().toLowerCase()
      if (!ACL_IP_VERSIONS.includes(ipVersion as (typeof ACL_IP_VERSIONS)[number])) {
        errors.push({ field: `${rLabel}.ipVersion`, message: `Rule ${ri} has an unsupported ipVersion "${rule.ipVersion}" — must be one of ${ACL_IP_VERSIONS.join(', ')}.`, code: 'INVALID_IP_VERSION' })
      }

      if (!String(rule.srcCidr ?? '').trim()) {
        errors.push({ field: `${rLabel}.srcCidr`, message: `Rule ${ri} requires srcCidr.`, code: 'REQUIRED' })
      }
      if (!String(rule.dstCidr ?? '').trim()) {
        errors.push({ field: `${rLabel}.dstCidr`, message: `Rule ${ri} requires dstCidr.`, code: 'REQUIRED' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
