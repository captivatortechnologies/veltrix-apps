import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import {
  buildClusterFields,
  galaxiesFromList,
  findGalaxyRef,
  clustersFromList,
  findCluster,
  normalizeYesNo,
  type MispGalaxyCluster,
} from './_shared'

/**
 * Deploy MISP galaxy clusters over the REST API (443):
 *   resolve galaxy:   GET  /galaxies                          → match by uuid/type/name
 *   read (rollback):  POST /galaxy_clusters/index/<galaxyId>   → find the live cluster by value
 *   create:           POST /galaxy_clusters/add/<galaxyId>      with { GalaxyCluster: {...} }
 *   update:           POST /galaxy_clusters/edit/<id>            with { GalaxyCluster: {...} }
 *   publish:          POST /galaxy_clusters/publish/<id>          (only when Publish is Yes)
 *
 * `value` is the stable identity used to upsert WITHIN its resolved galaxy. A
 * cluster whose live match is one of MISP's own default clusters (`default: true`)
 * is skipped — this type never edits the library MISP ships. An item whose
 * `galaxy` reference cannot be resolved is also skipped (this type cannot create
 * a galaxy on the fly — use the separate "Galaxies" config type for that).
 * rollbackData records, per item, the resolved galaxy id, the prior cluster body
 * (null when it did not exist) and its id, and whether it was published before —
 * a prior body restores via edit + a re-applied prior published state; a newly
 * created cluster (no prior body) is soft-deleted on rollback via
 * /galaxy_clusters/delete/<id>.
 *
 * NOTE: verify /galaxies + /galaxy_clusters/index|add|edit|publish|unpublish|delete
 * against a live MISP 2.4 instance.
 */
interface ClusterMutationResponse {
  GalaxyCluster?: MispGalaxyCluster
}

async function listClusters(base: string, headers: Record<string, string>, galaxyId: number | string): Promise<MispGalaxyCluster[]> {
  try {
    return clustersFromList(
      await sendJson<unknown>('POST', `${base}/galaxy_clusters/index/${encodeURIComponent(String(galaxyId))}`, headers, { context: 'all' }),
    )
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for galaxy cluster deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{
    galaxy: string
    value: string
    galaxyId: number | string
    clusterId: number | string | null
    cluster: MispGalaxyCluster | null
    publishedBefore: boolean | null
  }> = []
  const applied: string[] = []
  const skipped: string[] = []
  const clustersByGalaxy = new Map<string, MispGalaxyCluster[]>()

  try {
    const galaxies = galaxiesFromList(await getJson<unknown>(`${base}/galaxies`, headers))

    for (const item of items) {
      const galaxyRef = String(item.fields.galaxy ?? '').trim()
      const value = String(item.fields.value ?? '').trim()
      if (!galaxyRef || !value) continue

      const galaxy = findGalaxyRef(galaxies, galaxyRef)
      if (!galaxy || galaxy.id == null) {
        skipped.push(`${galaxyRef}/${value} (galaxy not found)`)
        continue
      }
      const galaxyId = galaxy.id

      const cacheKey = String(galaxyId)
      let clusters = clustersByGalaxy.get(cacheKey)
      if (!clusters) {
        clusters = await listClusters(base, headers, galaxyId)
        clustersByGalaxy.set(cacheKey, clusters)
      }

      const existing = findCluster(clusters, value)
      const rawMatch = clusters.find((c) => String(c.value ?? '').trim().toLowerCase() === value.toLowerCase())
      if (rawMatch && normalizeYesNo(rawMatch.default)) {
        skipped.push(`${galaxyRef}/${value} (default cluster)`)
        continue
      }

      const desiredPublish = normalizeYesNo(item.fields.publish)
      const body = { GalaxyCluster: buildClusterFields(item.fields) }

      let clusterId: number | string | null
      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/galaxy_clusters/edit/${encodeURIComponent(String(existing.id))}`, headers, body)
        clusterId = existing.id
        previous.push({ galaxy: galaxyRef, value, galaxyId, clusterId, cluster: existing, publishedBefore: normalizeYesNo(existing.published) })
      } else {
        const created = await sendJson<ClusterMutationResponse>('POST', `${base}/galaxy_clusters/add/${encodeURIComponent(String(galaxyId))}`, headers, body)
        clusterId = created?.GalaxyCluster?.id ?? null
        previous.push({ galaxy: galaxyRef, value, galaxyId, clusterId, cluster: null, publishedBefore: null })
      }

      if (desiredPublish && clusterId != null) {
        await sendJson('POST', `${base}/galaxy_clusters/publish/${encodeURIComponent(String(clusterId))}`, headers, {})
      }
      applied.push(`${galaxyRef}/${value}`)
    }

    const skipNote = skipped.length ? ` (skipped ${skipped.length}: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Applied ${applied.length} galaxy cluster(s): ${applied.join(', ') || '(none)'}${skipNote}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Galaxy cluster deploy failed after ${applied.length} cluster(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skipped },
      rollbackData: { previous },
    }
  }
}
