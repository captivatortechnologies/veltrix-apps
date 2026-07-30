import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { findTeamByName } from './_shared'

/**
 * Drift for teams: compare the team description we declare against the live team
 * in Fleet (the name is the identity). Best-effort — a team that can't be read
 * (missing / transient error / non-Premium tier) is skipped rather than raising
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

    const live = await findTeamByName(base, headers, name)
    if (!live) continue // best-effort: skip a team we can't read / that doesn't exist

    const expectedDescription = String(item.fields.description ?? '').trim()
    if (live.description !== undefined && (live.description ?? '') !== expectedDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: live.description ?? null, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
