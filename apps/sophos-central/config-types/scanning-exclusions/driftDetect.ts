import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { listScanningExclusions } from '../../lib/sophosApi'
import { extractScanningExclusionSpecs, scanningExclusionKey, scanningExclusionMatches } from './_shared'

/**
 * Detect drift for scanning exclusions: for each declared (type, value)
 * pair, find the live exclusion and compare scanMode/comment. A declared
 * exclusion that no longer exists is critical drift; a changed scanMode or
 * comment is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractScanningExclusionSpecs(ctx.deployedConfig).filter((s) => s.type && s.value)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await listScanningExclusions(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByKey = new Map(live.map((e) => [scanningExclusionKey(e.type, e.value), e] as const))

  for (const spec of specs) {
    const label = `${spec.type}:${spec.value}`
    const match = liveByKey.get(scanningExclusionKey(spec.type, spec.value))
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }
    if (!scanningExclusionMatches(spec, match)) {
      diffs.push({
        field: `${label}.settings`,
        expected: { scanMode: spec.scanMode || '(default)', comment: spec.comment },
        actual: { scanMode: match.scanMode ?? '', comment: match.comment ?? '' },
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
