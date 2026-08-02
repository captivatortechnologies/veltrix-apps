import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE, looksLikeKnownNetworkId } from '../../lib/merakiCommon'
import { extractGroupPolicySpecs, groupPolicyKey, IGNORED_POLICY_KEYS, networkIdKey, parseJsonObject } from './_shared'

/** Well-known top-level `*.settings` enums — the only nested fields validated beyond "is this valid JSON". */
const SETTINGS_ENUM_PATHS: Array<{ path: string[]; values: readonly string[] }> = [
  { path: ['bandwidth', 'settings'], values: ['custom', 'ignore', 'network default'] },
  { path: ['firewallAndTrafficShaping', 'settings'], values: ['custom', 'ignore', 'network default'] },
  { path: ['vlanTagging', 'settings'], values: ['custom', 'ignore', 'network default'] },
  { path: ['bonjourForwarding', 'settings'], values: ['custom', 'ignore', 'network default'] },
  { path: ['contentFiltering', 'allowedUrlPatterns', 'settings'], values: ['append', 'network default', 'override'] },
  { path: ['contentFiltering', 'blockedUrlPatterns', 'settings'], values: ['append', 'network default', 'override'] },
  { path: ['contentFiltering', 'blockedUrlCategories', 'settings'], values: ['append', 'network default', 'override'] },
  { path: ['splashAuthSettings'], values: ['bypass', 'network default'] },
]

function readPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/**
 * Validate group policy item(s): a well-formed `network_id`, a required
 * `name` unique per network, and a `policy` value that parses to a JSON
 * object. Only the well-known top-level `*.settings` enums inside `policy`
 * are checked — the rest of the (large, deeply nested) schema is passed
 * through as declared and validated by Meraki itself at deploy time. Static —
 * no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one group policy.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const networkId = String(item.fields.network_id ?? '').trim()
    const name = String(item.fields.name ?? '').trim()
    const prefix = `items[${i}]`

    if (!networkId) {
      errors.push({ field: `${prefix}.network_id`, message: 'Meraki network id is required.', code: 'REQUIRED' })
    } else if (!NETWORK_ID_RE.test(networkId)) {
      errors.push({
        field: `${prefix}.network_id`,
        message: `Network id "${networkId}" may contain only letters, digits, underscore and hyphen.`,
        code: 'INVALID_NETWORK_ID',
      })
    } else if (!looksLikeKnownNetworkId(networkId)) {
      warnings.push({
        field: `${prefix}.network_id`,
        message: `Network id "${networkId}" does not start with the usual "L_" or "N_" prefix — double-check it against the Meraki dashboard.`,
        code: 'UNUSUAL_NETWORK_ID',
      })
    }

    if (!name) {
      errors.push({ field: `${prefix}.name`, message: 'Group policy name is required.', code: 'REQUIRED' })
    } else if (networkId) {
      const key = `${networkIdKey(networkId)}::${groupPolicyKey(name)}`
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `Group policy "${name}" is listed more than once in network "${networkId}"; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    const { value: policy, error } = parseJsonObject(item.fields.policy, 'policy')
    if (error) {
      errors.push({ field: `${prefix}.policy`, message: error, code: 'INVALID_POLICY' })
      return
    }
    if (!policy) return

    const ignoredPresent = IGNORED_POLICY_KEYS.filter((k) => k in policy)
    if (ignoredPresent.length > 0) {
      warnings.push({
        field: `${prefix}.policy`,
        message: `"${ignoredPresent.join('", "')}" in the policy JSON ${ignoredPresent.length > 1 ? 'are' : 'is'} ignored — identity comes from the Name field and Meraki's assigned id.`,
        code: 'IGNORED_POLICY_KEY',
      })
    }

    for (const { path, values } of SETTINGS_ENUM_PATHS) {
      const value = readPath(policy, path)
      if (value === undefined) continue
      if (typeof value !== 'string' || !values.includes(value)) {
        errors.push({
          field: `${prefix}.policy.${path.join('.')}`,
          message: `"${path.join('.')}" must be one of ${values.map((v) => `"${v}"`).join(', ')} (got ${JSON.stringify(value)}).`,
          code: 'INVALID_SETTINGS_ENUM',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
