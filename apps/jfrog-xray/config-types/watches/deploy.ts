import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { buildWatchBody, extractWatchSpecs, findWatch, type XrayWatch } from './_shared'

export const WATCHES_PATH = '/api/v2/watches'
export const watchPath = (name: string): string => `${WATCHES_PATH}/${encodeURIComponent(name)}`

export interface WatchRollbackEntry {
  name: string
  existed: boolean
  /** The full prior watch body (read before the PUT) — used to restore an updated watch on rollback. */
  prior?: XrayWatch
}

/**
 * Deploy JFrog Xray watches over the Xray REST API v2:
 *   read (identity + rollback): GET  /api/v2/watches            → match by name
 *                                GET  /api/v2/watches/{name}     → full prior body, for rollback
 *   create:                     POST /api/v2/watches             with the full watch body
 *   update:                     PUT  /api/v2/watches/{name}      with the full watch body (Xray has
 *                                                                 no partial update — "This overwrites
 *                                                                 the previous Watch configuration")
 * Upserts by NAME. rollbackData records, per watch, whether it existed and (when it did) its full
 * prior body, so rollback can either delete what we created or PUT the exact prior state back.
 *
 * Verified against the JFrog Xray REST API v2 watches reference:
 *   https://docs.jfrog.com/security/reference/create-watch_watches-v2-openapi
 *   https://docs.jfrog.com/security/reference/get-watches_watches-v2-openapi
 *   https://docs.jfrog.com/security/reference/get-watch_watches-v2-openapi
 *   https://docs.jfrog.com/security/reference/update-watch_watches-v2-openapi
 *   https://docs.jfrog.com/security/reference/delete-watch_watches-v2-openapi
 * and cross-checked against JFrog's own Terraform provider for field names/casing:
 *   https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/watch.md
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, host } = built

  const specs = extractWatchSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: WatchRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await client.getJson<XrayWatch[]>(WATCHES_PATH)

    for (const spec of specs) {
      const desired = buildWatchBody(spec)
      const existing = findWatch(Array.isArray(live) ? live : [], spec.name)

      if (existing) {
        const prior = await client.getJson<XrayWatch>(watchPath(spec.name))
        rollbackState.push({ name: spec.name, existed: true, prior })
        await client.putJson(watchPath(spec.name), desired)
      } else {
        rollbackState.push({ name: spec.name, existed: false })
        await client.postJson(WATCHES_PATH, desired)
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Xray watch${deployed.length === 1 ? '' : 'es'} to ${host}: ${deployed.join(', ')}`,
      artifacts: { host, deployedWatches: deployed },
      rollbackData: { previous: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Xray watch deployment failed after ${deployed.length} of ${specs.length}: ${errorMessage(error)}`,
      artifacts: { host, deployedWatches: deployed },
      rollbackData: { previous: rollbackState },
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error'
}
