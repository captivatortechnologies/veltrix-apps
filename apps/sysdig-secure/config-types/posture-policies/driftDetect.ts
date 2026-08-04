import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { findPolicySummaryByName, normalizeBoolean, parseRequirementGroups } from './_shared'

/**
 * Drift for posture policies: compare presence and the declared set of
 * requirement-group names against the live policy. Best-effort — a policy
 * that can't be read is skipped rather than raising false drift. Read-only:
 * GET /api/cspm/v1/policy/policies/list +
 * GET /api/cspm/v1/policy/posture/policies/<id>.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let summaries
  try {
    summaries = await client.listPosturePolicies()
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const enabled = normalizeBoolean(item.fields.enabled, true)
    const summary = findPolicySummaryByName(summaries, name)

    if (!enabled) {
      if (summary) diffs.push({ field: `${name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!summary) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    let live
    try {
      live = await client.getPosturePolicyById(summary.id)
    } catch {
      continue
    }
    if (!live) continue

    const expectedGroups = parseRequirementGroups(item.fields.requirementGroupsJson).map((g) => g.name).sort()
    const actualGroups = (live.groups ?? []).map((g) => String(g.name ?? '')).sort()
    if (JSON.stringify(expectedGroups) !== JSON.stringify(actualGroups)) {
      diffs.push({ field: `${name}.groups`, expected: expectedGroups, actual: actualGroups, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
