import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient } from '../../lib/umbrellaApi'
import {
  LIST_PATH,
  destinationKey,
  extractDestinationListSpecs,
  listDestinations,
  type LiveDestinationList,
} from './_shared'

type Diffs = DriftResult['diffs']

/**
 * Drift for destination lists: compare the declared lists against Umbrella. A
 * declared list that is absent is critical drift; a present one is compared on
 * access, global scope and its destination set (all warnings). Best-effort and
 * read-only — if live state can't be read, no drift is asserted.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractDestinationListSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveDestinationList>(LIST_PATH)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    if (live.access && live.access !== spec.access) {
      diffs.push({ field: `${spec.name}.access`, expected: spec.access, actual: live.access, severity: 'warning' })
    }
    if (typeof live.isGlobal === 'boolean' && live.isGlobal !== spec.isGlobal) {
      diffs.push({ field: `${spec.name}.isGlobal`, expected: spec.isGlobal, actual: live.isGlobal, severity: 'warning' })
    }

    const current = await listDestinations(client, live.id)
    if (!current.ok) continue
    const liveKeys = new Set(current.items.map((d) => destinationKey(d.destination ?? '')).filter(Boolean))
    const declaredKeys = new Set(spec.destinations.map(destinationKey))

    const missing = [...declaredKeys].filter((k) => !liveKeys.has(k))
    const extra = [...liveKeys].filter((k) => !declaredKeys.has(k))
    if (missing.length || extra.length) {
      diffs.push({
        field: `${spec.name}.destinations`,
        expected: `${declaredKeys.size} declared`,
        actual: `${liveKeys.size} live (${missing.length} missing, ${extra.length} extra)`,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
