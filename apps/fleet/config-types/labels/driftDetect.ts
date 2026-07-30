import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { findLabelByName } from './_shared'

/**
 * Drift for labels: compare the osquery SQL selector we declare against the live
 * label in Fleet. Best-effort — a label that can't be read (missing / transient
 * error) is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    const live = await findLabelByName(base, headers, name)
    if (!live) continue // best-effort: skip a label we can't read / that doesn't exist

    const expectedQuery = String(item.fields.query ?? '')
    if (live.query !== undefined && live.query !== expectedQuery) {
      diffs.push({ field: `${name}.query`, expected: expectedQuery, actual: live.query ?? null, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
