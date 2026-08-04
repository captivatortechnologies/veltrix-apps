import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildPackSpec, groupOf, listPacks, findPack, connectFor, type PackInstallInfo } from './_shared'
import { canonicalJson, pickKeys } from '../../lib/criblCommon'

/**
 * Drift for Packs: compare the fields we declare (source, spec, displayName,
 * description, author, disabled) against the live Pack (read-only GET). The
 * live `version` (Cribl's currently-resolved version for our `spec`
 * constraint) is intentionally NOT compared — a version bump from a loose
 * `spec` like "^1.3.0" is expected drift-free behavior, not configuration
 * drift. A pack we declare but that is missing in Cribl is critical drift.
 * Best-effort — a group we can't read is skipped. Verify against a live Cribl.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  let base: string
  let headers: Record<string, string>
  try {
    ;({ base, headers } = await connectFor({ component, credential, connectivity, connectivityProvider, settings }))
  } catch {
    return { hasDrift: false, diffs }
  }

  const liveByGroup = new Map<string, PackInstallInfo[] | null>()
  const loadGroup = async (group: string): Promise<PackInstallInfo[] | null> => {
    if (liveByGroup.has(group)) return liveByGroup.get(group)!
    let live: PackInstallInfo[] | null
    try {
      live = await listPacks(base, headers, group)
    } catch {
      live = null
    }
    liveByGroup.set(group, live)
    return live
  }

  for (const item of items) {
    const spec = buildPackSpec(item.fields)
    if (!spec.id || spec.error || !spec.body) continue

    const group = groupOf(item.fields, settings ?? {})
    const live = await loadGroup(group)
    if (live === null) continue

    const label = group ? `${group}/${spec.id}` : spec.id
    const match = findPack(live, spec.id)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const keys = Object.keys(spec.body).filter((k) => k !== 'id')
    const expected = pickKeys(spec.body, keys)
    const actual = pickKeys(match, keys)
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      diffs.push({ field: label, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
