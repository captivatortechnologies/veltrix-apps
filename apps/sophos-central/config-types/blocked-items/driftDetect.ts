import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { listBlockedItems } from '../../lib/sophosApi'
import { blockedItemKey, blockedItemMatches, extractBlockedItemSpecs } from './_shared'

/**
 * Detect drift for blocked items: for each declared SHA256, find the live
 * item and compare fileName/path/comment. A declared hash that no longer
 * exists is critical drift (Sophos would no longer always-convict it); a
 * changed fileName/path/comment is a warning (there's no PATCH to silently
 * lose, but it means a future deploy will delete+recreate the item).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractBlockedItemSpecs(ctx.deployedConfig).filter((s) => s.sha256)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await listBlockedItems(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByHash = new Map(live.filter((i) => i.properties?.sha256).map((i) => [blockedItemKey(i.properties.sha256), i]))

  for (const spec of specs) {
    const match = liveByHash.get(blockedItemKey(spec.sha256))
    if (!match) {
      diffs.push({ field: spec.sha256, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }
    if (!blockedItemMatches(spec, match)) {
      diffs.push({
        field: `${spec.sha256}.properties`,
        expected: { fileName: spec.fileName, path: spec.path, comment: spec.comment },
        actual: { fileName: match.properties?.fileName ?? '', path: match.properties?.path ?? '', comment: match.comment ?? '' },
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
