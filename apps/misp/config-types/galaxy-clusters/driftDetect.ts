import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { galaxiesFromList, findGalaxyRef, clustersFromList, findCluster, normalizeYesNo, type MispGalaxyCluster } from './_shared'

/**
 * Drift for galaxy clusters: compare the declared distribution, description and
 * published state against the live cluster in MISP. Best-effort — a galaxy or
 * cluster that can't be resolved (missing / transient error) is skipped rather
 * than raising false drift. Read-only: GET /galaxies, POST
 * /galaxy_clusters/index/<galaxyId>. Verify against a live MISP 2.4 instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let galaxies
  try {
    galaxies = galaxiesFromList(await getJson<unknown>(`${base}/galaxies`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read galaxies, no drift asserted
  }

  const clustersByGalaxy = new Map<string, MispGalaxyCluster[]>()

  for (const item of items) {
    const galaxyRef = String(item.fields.galaxy ?? '').trim()
    const value = String(item.fields.value ?? '').trim()
    if (!galaxyRef || !value) continue

    const galaxy = findGalaxyRef(galaxies, galaxyRef)
    if (!galaxy || galaxy.id == null) continue

    const cacheKey = String(galaxy.id)
    let clusters = clustersByGalaxy.get(cacheKey)
    if (!clusters) {
      try {
        clusters = clustersFromList(
          await sendJson<unknown>('POST', `${base}/galaxy_clusters/index/${encodeURIComponent(String(galaxy.id))}`, headers, { context: 'all' }),
        )
      } catch {
        clusters = []
      }
      clustersByGalaxy.set(cacheKey, clusters)
    }

    const match = findCluster(clusters, value)
    if (!match) continue

    const label = `${galaxyRef}/${value}`

    const expectedDistribution = Number(item.fields.distribution ?? 0)
    const actualDistribution = Number(match.distribution ?? 0)
    if (expectedDistribution !== actualDistribution) {
      diffs.push({ field: `${label}.distribution`, expected: expectedDistribution, actual: actualDistribution, severity: 'warning' })
    }

    const expectedDescription = String(item.fields.description ?? '').trim()
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription && actualDescription !== expectedDescription) {
      diffs.push({ field: `${label}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedPublish = normalizeYesNo(item.fields.publish)
    const actualPublish = normalizeYesNo(match.published)
    if (expectedPublish !== actualPublish) {
      diffs.push({ field: `${label}.publish`, expected: expectedPublish, actual: actualPublish, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
