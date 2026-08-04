import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispGalaxyCluster } from './_shared'

/**
 * Undo a galaxy-clusters deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, POST /galaxy_clusters/edit/<id> to restore it
 * plus /galaxy_clusters/publish|unpublish/<id> to restore its prior published
 * state; a newly created cluster (prior body null) is soft-deleted via POST
 * /galaxy_clusters/delete/<id>. Applied over the MISP REST API (443). Verify
 * /galaxy_clusters/edit|publish|unpublish|delete/<id> against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{
      clusterId: number | string | null
      cluster: MispGalaxyCluster | null
      publishedBefore: boolean | null
    }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for galaxy cluster rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { clusterId, cluster, publishedBefore } of previous) {
      if (clusterId == null) continue // never learned an id — nothing addressable to undo
      if (cluster) {
        await sendJson('POST', `${base}/galaxy_clusters/edit/${encodeURIComponent(String(clusterId))}`, headers, { GalaxyCluster: cluster })
        if (publishedBefore !== null) {
          await sendJson('POST', `${base}/galaxy_clusters/${publishedBefore ? 'publish' : 'unpublish'}/${encodeURIComponent(String(clusterId))}`, headers, {})
        }
        restored++
      } else {
        await sendJson('POST', `${base}/galaxy_clusters/delete/${encodeURIComponent(String(clusterId))}`, headers, {})
        deleted++
      }
    }
    return { success: true, message: `Rolled back galaxy clusters: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
