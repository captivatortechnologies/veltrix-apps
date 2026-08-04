import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { findZoneByName, normalizeBoolean, parseScopes } from './_shared'

/**
 * Drift for zones: compare presence and the declared scope count/targetTypes
 * against the live zone. Best-effort — a zone that can't be read is skipped
 * rather than raising false drift. Read-only: GET /platform/v1/zones.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const enabled = normalizeBoolean(item.fields.enabled, true)

    let live
    try {
      live = findZoneByName(await client.findZonesByName(name), name)
    } catch {
      continue
    }

    if (!enabled) {
      if (live) diffs.push({ field: `${name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!live) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedTypes = parseScopes(item.fields.scopesJson).map((s) => s.targetType).sort()
    const actualTypes = (live.scopes ?? []).map((s) => String(s.targetType ?? '')).sort()
    if (JSON.stringify(expectedTypes) !== JSON.stringify(actualTypes)) {
      diffs.push({ field: `${name}.scopes.targetType`, expected: expectedTypes, actual: actualTypes, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
