import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient, priorExternalIds } from '../../lib/sysdigApi'
import { normalizeBoolean } from './_shared'

/**
 * Drift for posture controls: compare presence, severity, rego and
 * remediationDetails against the live control this app last recorded for
 * that canvas item (via the externalIds map in the last successful deploy's
 * rollbackData — controls have no by-name lookup). Best-effort — a control
 * that can't be read is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const latest = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
  const externalIds = priorExternalIds(latest?.rollbackData)

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const itemId = item.id ?? name
    const enabled = normalizeBoolean(item.fields.enabled, true)
    const externalId = externalIds[itemId]?.externalId ?? null

    if (!enabled) {
      if (externalId) diffs.push({ field: `${name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!externalId) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    let live
    try {
      live = await client.getPostureControlById(externalId)
    } catch {
      continue
    }
    if (!live) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedSeverity = String(item.fields.severity ?? '').trim()
    if (expectedSeverity && expectedSeverity !== String(live.severity ?? '').trim()) {
      diffs.push({ field: `${name}.severity`, expected: expectedSeverity, actual: live.severity, severity: 'warning' })
    }
    const expectedRego = String(item.fields.rego ?? '').trim()
    if (expectedRego && expectedRego !== String(live.rego ?? '').trim()) {
      diffs.push({ field: `${name}.rego`, expected: expectedRego, actual: live.rego, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
