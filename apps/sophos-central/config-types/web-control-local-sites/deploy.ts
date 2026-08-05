import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { createLocalSite, listLocalSites, updateLocalSite, type SophosLocalSite } from '../../lib/sophosApi'
import { buildLocalSiteBody, extractLocalSiteSpecs, localSiteKey, localSiteMatches } from './_shared'

export interface LocalSiteRollbackEntry {
  url: string
  existed: boolean
  id?: string
  prior?: SophosLocalSite
}

/**
 * Deploy Sophos Central web control local sites, reconciled by `url`:
 *   list:   GET   /settings/web-control/local-sites          -> find by url
 *   update: PATCH /settings/web-control/local-sites/{id}      when found and different
 *   create: POST  /settings/web-control/local-sites           when not found
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractLocalSiteSpecs(ctx.canvas).filter((s) => s.url)
  const previous: LocalSiteRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listLocalSites(client)
    const liveByUrl = new Map(live.map((s) => [localSiteKey(s.url), s] as const))

    for (const spec of specs) {
      const match = liveByUrl.get(localSiteKey(spec.url))

      if (!match) {
        const created = await createLocalSite(client, buildLocalSiteBody(spec))
        previous.push({ url: spec.url, existed: false, id: created.id })
      } else if (localSiteMatches(spec, match)) {
        previous.push({ url: spec.url, existed: true, id: match.id, prior: match })
      } else {
        if (match.id) await updateLocalSite(client, match.id, buildLocalSiteBody(spec))
        previous.push({ url: spec.url, existed: true, id: match.id, prior: match })
      }
      deployed.push(spec.url)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} local site(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Local site deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
