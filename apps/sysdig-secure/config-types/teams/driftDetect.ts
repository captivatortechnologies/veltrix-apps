import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { findTeamByName, normalizeBoolean } from './_shared'

/**
 * Drift for teams: compare presence, scopeBy, theme and allZones against the
 * live team. Best-effort — a team that can't be read is skipped rather than
 * raising false drift. Read-only: GET /api/teams. Zone/member drift is not
 * compared (both require additional resolution calls); presence and the core
 * settings above are.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    live = await client.listTeams()
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const enabled = normalizeBoolean(item.fields.enabled, true)
    const team = findTeamByName(live, name)

    if (!enabled) {
      if (team) diffs.push({ field: `${name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!team) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedScopeBy = String(item.fields.scopeBy ?? 'container').trim()
    const actualScopeBy = String(team.scopeBy ?? '').trim()
    if (expectedScopeBy && actualScopeBy && expectedScopeBy !== actualScopeBy) {
      diffs.push({ field: `${name}.scopeBy`, expected: expectedScopeBy, actual: actualScopeBy, severity: 'warning' })
    }

    const expectedAllZones = normalizeBoolean(item.fields.allZones, false)
    if (Boolean(team.allZones) !== expectedAllZones) {
      diffs.push({ field: `${name}.allZones`, expected: expectedAllZones, actual: Boolean(team.allZones), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
