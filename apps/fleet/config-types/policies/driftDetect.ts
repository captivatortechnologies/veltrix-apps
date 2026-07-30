import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { findPolicyByName, toFleetPlatform, normalizeCritical } from './_shared'

/**
 * Drift for global policies: compare the osquery SQL check, target platform and
 * criticality we declare against the live policy in Fleet. Best-effort — a policy
 * that can't be read (missing / transient error) is skipped rather than raising
 * false drift.
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

    const live = await findPolicyByName(base, headers, name)
    if (!live) continue // best-effort: skip a policy we can't read / that doesn't exist

    const expectedQuery = String(item.fields.query ?? '')
    if (live.query !== undefined && live.query !== expectedQuery) {
      diffs.push({ field: `${name}.query`, expected: expectedQuery, actual: live.query ?? null, severity: 'warning' })
    }

    const expectedPlatform = toFleetPlatform(item.fields.platform)
    if (live.platform !== undefined && live.platform !== expectedPlatform) {
      diffs.push({ field: `${name}.platform`, expected: expectedPlatform, actual: live.platform ?? null, severity: 'warning' })
    }

    const expectedCritical = normalizeCritical(item.fields.critical)
    if (live.critical !== undefined && live.critical !== expectedCritical) {
      diffs.push({ field: `${name}.critical`, expected: expectedCritical, actual: live.critical ?? null, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
