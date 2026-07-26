import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractOverrideSpecs, liveNaturalKey, naturalKey, type LiveOverride } from './validate'
import { definitionEquals } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)

  const specs = extractOverrideSpecs(ctx.deployedConfig).filter((s) => s.label)
  const listed = await client.searchAll<LiveOverride>()
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map<string, LiveOverride>()
  for (const o of listed.items) liveByKey.set(liveNaturalKey(o), o)

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByKey.get(naturalKey(spec))
    if (!live) {
      diffs.push({ field: spec.label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!definitionEquals(live, spec)) {
      if ((live.override_list ?? '') !== spec.overrideList) {
        diffs.push({ field: `${spec.label}.override_list`, expected: spec.overrideList, actual: live.override_list ?? '', severity: 'warning' })
      }
      if ((live.description ?? '') !== spec.description) {
        diffs.push({ field: `${spec.label}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
      }
      if (spec.overrideType === 'IT_TOOL' && (live.include_child_processes ?? false) !== spec.includeChildProcesses) {
        diffs.push({ field: `${spec.label}.include_child_processes`, expected: spec.includeChildProcesses, actual: live.include_child_processes ?? false, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
