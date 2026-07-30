import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { findQueryByName, toFleetPlatform } from './_shared'

/**
 * Drift for saved queries: compare the osquery SQL, schedule interval and target
 * platform we declare against the live query in Fleet. Best-effort — a query that
 * can't be read (missing / transient error) is skipped rather than raising false
 * drift.
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

    const live = await findQueryByName(base, headers, name)
    if (!live) continue // best-effort: skip a query we can't read / that doesn't exist

    const expectedQuery = String(item.fields.query ?? '')
    if (live.query !== undefined && live.query !== expectedQuery) {
      diffs.push({ field: `${name}.query`, expected: expectedQuery, actual: live.query ?? null, severity: 'warning' })
    }

    const expectedInterval = Number(item.fields.interval)
    if (typeof live.interval === 'number' && Number.isFinite(expectedInterval) && live.interval !== expectedInterval) {
      diffs.push({ field: `${name}.interval`, expected: expectedInterval, actual: live.interval, severity: 'warning' })
    }

    const expectedPlatform = toFleetPlatform(item.fields.platform)
    if (live.platform !== undefined && live.platform !== expectedPlatform) {
      diffs.push({ field: `${name}.platform`, expected: expectedPlatform, actual: live.platform ?? null, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
