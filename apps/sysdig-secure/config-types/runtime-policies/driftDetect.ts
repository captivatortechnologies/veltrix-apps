import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, type SysdigPolicy } from '../../lib/sysdigApi'
import {
  actionTypesOf,
  buildActions,
  findPolicyByName,
  normalizeEnabled,
  normalizeSeverity,
  ruleNamesOf,
  splitList,
} from './_shared'

/**
 * Drift for runtime policies: compare the presence + severity / referenced rules
 * / response actions / scope we declare against the live policy in Sysdig Secure.
 * Best-effort — the policy list is read once; a read error asserts no drift
 * rather than raising false positives. Read-only: GET /api/v2/policies.
 *
 * An enabled policy that is missing, or whose body diverged, is drift. A disabled
 * policy that still exists is drift (this app removes it).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let policies: SysdigPolicy[]
  try {
    policies = await client.listPolicies()
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read policies, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const enabled = normalizeEnabled(item.fields.enabled)
    const live = findPolicyByName(policies, name)

    if (!enabled) {
      if (live) diffs.push({ field: `${name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!live) {
      diffs.push({ field: `${name}`, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedSeverity = normalizeSeverity(item.fields.severity)
    const actualSeverity = normalizeSeverity(live.severity)
    if (expectedSeverity !== actualSeverity) {
      diffs.push({ field: `${name}.severity`, expected: expectedSeverity, actual: actualSeverity, severity: 'warning' })
    }

    const declaredRules = [...splitList(item.fields.ruleNames)].sort()
    const actualRules = ruleNamesOf(live)
    if (declaredRules.join('|') !== actualRules.join('|')) {
      diffs.push({ field: `${name}.ruleNames`, expected: declaredRules.join(', '), actual: actualRules.join(', '), severity: 'critical' })
    }

    const declaredActions = actionTypesOf({ name, actions: buildActions(item.fields.actions) } as SysdigPolicy)
    const actualActions = actionTypesOf(live)
    if (declaredActions.join('|') !== actualActions.join('|')) {
      diffs.push({ field: `${name}.actions`, expected: declaredActions.join(', '), actual: actualActions.join(', '), severity: 'warning' })
    }

    const expectedScope = String(item.fields.scope ?? '').trim()
    const actualScope = String(live.scope ?? '').trim()
    if (expectedScope !== actualScope) {
      diffs.push({ field: `${name}.scope`, expected: expectedScope, actual: actualScope, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
