import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient } from '../../lib/akeyless'
import { extractAccessLevels, getRole, type AccessLevels } from './deploy'
import { extractRoleSpecs } from './validate'

const ACCESS_LEVEL_KEYS: (keyof AccessLevels)[] = [
  'auditAccess',
  'analyticsAccess',
  'gwAnalyticsAccess',
  'sraReportsAccess',
  'usageReportsAccess',
  'eventCenterAccess',
  'isiAccess',
  'reverseRbacAccess',
]

/**
 * Detect drift between the deployed role configuration and the live
 * account. Re-finds each declared role by NAME and compares:
 *   - description / delete_protection / dashboard access levels
 *   - every declared rule is still present with the same capabilities
 *     (additive-only, so a rule this app never deleted is not flagged)
 *   - the auth-method association SET matches exactly (full replace, so an
 *     extra live association not declared here IS flagged)
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    let live
    try {
      live = await getRole(client, spec.name)
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    if ((live.comment ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description || '(none)', actual: live.comment || '(none)', severity: 'warning' })
    }
    if (Boolean(live.delete_protection) !== spec.deleteProtection) {
      diffs.push({
        field: `${spec.name}.deleteProtection`,
        expected: String(spec.deleteProtection),
        actual: String(Boolean(live.delete_protection)),
        severity: 'warning',
      })
    }

    const liveLevels = extractAccessLevels(live.rules?.path_rules ?? [])
    for (const key of ACCESS_LEVEL_KEYS) {
      if ((spec[key] || '') !== (liveLevels[key] || '')) {
        diffs.push({
          field: `${spec.name}.${key}`,
          expected: spec[key] || '(unset)',
          actual: liveLevels[key] || '(unset)',
          severity: 'warning',
        })
      }
    }

    const liveRuleKeys = new Map((live.rules?.path_rules ?? []).map((r) => [`${r.type}::${r.path}`, r.capabilities ?? []]))
    for (const rule of spec.rules) {
      const liveCaps = liveRuleKeys.get(`${rule.ruleType}::${rule.path}`)
      if (!liveCaps) {
        diffs.push({ field: `${spec.name}.rules[${rule.path}]`, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else if (!sameSet(liveCaps, rule.capability)) {
        diffs.push({
          field: `${spec.name}.rules[${rule.path}].capability`,
          expected: rule.capability.join(', '),
          actual: liveCaps.join(', '),
          severity: 'warning',
        })
      }
    }

    const liveAssocNames = new Set((live.role_auth_methods_assoc ?? []).map((a) => a.auth_method_name))
    const declaredAssocNames = new Set(spec.authMethodAssociations.map((a) => a.authMethodName))
    for (const name of declaredAssocNames) {
      if (!liveAssocNames.has(name)) {
        diffs.push({ field: `${spec.name}.authMethodAssociations[${name}]`, expected: 'associated', actual: 'not associated', severity: 'critical' })
      }
    }
    for (const name of liveAssocNames) {
      if (name && !declaredAssocNames.has(name)) {
        diffs.push({ field: `${spec.name}.authMethodAssociations[${name}]`, expected: 'not associated', actual: 'associated', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}
