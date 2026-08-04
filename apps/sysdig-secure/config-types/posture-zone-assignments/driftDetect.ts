import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { normalizeBoolean, splitOrderedList } from './_shared'

/**
 * Drift for zone assignments: compare the declared policy-name set against
 * the zone's live assigned policy ids (resolved back to names). Best-effort —
 * a zone/policy list that can't be read is skipped rather than raising false
 * drift. Read-only: GET /platform/v1/zones, GET
 * /api/cspm/v1/policy/policies/list, GET /api/cspm/v1/zones/<id>/policies.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let policySummaries
  try {
    policySummaries = await client.listPosturePolicies()
  } catch {
    return { hasDrift: false, diffs }
  }
  const nameById = new Map(policySummaries.map((p) => [p.id, p.name]))

  for (const item of items) {
    const zoneName = String(item.fields.zoneName ?? '').trim()
    if (!zoneName) continue
    const enabled = normalizeBoolean(item.fields.enabled, true)

    let zone
    try {
      zone = (await client.findZonesByName(zoneName)).find((z) => String(z.name ?? '').trim() === zoneName)
    } catch {
      continue
    }
    if (!zone || typeof zone.id !== 'number') {
      diffs.push({ field: zoneName, expected: 'zone present', actual: 'missing', severity: 'critical' })
      continue
    }

    let assignment
    try {
      assignment = await client.getZonePolicyAssignment(zone.id)
    } catch {
      continue
    }
    const actualNames = (assignment?.policyIds ?? []).map((id) => nameById.get(id) ?? id).sort()

    if (!enabled) {
      if (actualNames.length > 0) diffs.push({ field: `${zoneName}.policyNames`, expected: [], actual: actualNames, severity: 'warning' })
      continue
    }

    const expectedNames = [...splitOrderedList(item.fields.policyNames)].sort()
    if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
      diffs.push({ field: `${zoneName}.policyNames`, expected: expectedNames, actual: actualNames, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
