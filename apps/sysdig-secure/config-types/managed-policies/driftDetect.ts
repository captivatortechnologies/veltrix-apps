import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { actionKeysOf, findManagedPolicy, normalizeBoolean, splitList } from './_shared'

/**
 * Drift for managed policies: compare enabled, scope, response actions and
 * disabled-rule set against the live managed policy. Best-effort — a policy
 * that can't be read is skipped rather than raising false drift. Read-only:
 * GET /api/v2/policies.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let policies
  try {
    policies = await client.listPolicies()
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const type = String(item.fields.type ?? 'falco').trim()
    const enabled = normalizeBoolean(item.fields.enabled, true)
    const live = findManagedPolicy(policies, name, type)

    if (!live) {
      diffs.push({ field: `${name}`, expected: 'present (managed)', actual: 'missing', severity: 'critical' })
      continue
    }

    if (Boolean(live.enabled) !== enabled) {
      diffs.push({ field: `${name}.enabled`, expected: enabled, actual: Boolean(live.enabled), severity: 'warning' })
    }
    if (!enabled) continue

    const expectedScope = String(item.fields.scope ?? '').trim()
    const actualScope = String(live.scope ?? '').trim()
    if (expectedScope !== actualScope) {
      diffs.push({ field: `${name}.scope`, expected: expectedScope, actual: actualScope, severity: 'warning' })
    }

    const expectedActions = splitList(item.fields.actions).map((a) => a.toLowerCase()).sort()
    const actualActions = actionKeysOf(live)
    if (JSON.stringify(expectedActions) !== JSON.stringify(actualActions)) {
      diffs.push({ field: `${name}.actions`, expected: expectedActions, actual: actualActions, severity: 'warning' })
    }

    const expectedDisabled = [...splitList(item.fields.disabledRuleNames)].sort()
    const actualDisabled = (live.rules ?? []).filter((r) => !r.enabled).map((r) => r.ruleName).sort()
    if (JSON.stringify(expectedDisabled) !== JSON.stringify(actualDisabled)) {
      diffs.push({ field: `${name}.disabledRuleNames`, expected: expectedDisabled, actual: actualDisabled, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
