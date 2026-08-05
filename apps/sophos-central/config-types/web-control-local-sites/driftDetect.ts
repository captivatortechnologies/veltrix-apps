import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { listLocalSites } from '../../lib/sophosApi'
import { extractLocalSiteSpecs, localSiteKey, localSiteMatches } from './_shared'

/**
 * Detect drift for local sites: for each declared url, find the live site
 * and compare categoryId/tags/comment. A declared site that no longer exists
 * is critical drift; a changed classification is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractLocalSiteSpecs(ctx.deployedConfig).filter((s) => s.url)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await listLocalSites(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByUrl = new Map(live.map((s) => [localSiteKey(s.url), s] as const))

  for (const spec of specs) {
    const match = liveByUrl.get(localSiteKey(spec.url))
    if (!match) {
      diffs.push({ field: spec.url, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }
    if (!localSiteMatches(spec, match)) {
      diffs.push({
        field: `${spec.url}.classification`,
        expected: { categoryId: spec.categoryId, tags: spec.tags, comment: spec.comment },
        actual: { categoryId: match.categoryId, tags: match.tags ?? [], comment: match.comment ?? '' },
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
