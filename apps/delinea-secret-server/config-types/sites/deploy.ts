import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage, parseJson } from '../../lib/secretServerApi'
import {
  extractSiteSpecs,
  searchSites,
  findSiteByName,
  buildSiteCreateBody,
  buildSiteUpdateBody,
  siteIdOf,
  type LiveSite,
} from './_shared'

/**
 * One site's prior state, captured for rollback. `existed` distinguishes an
 * UPDATE (restore `prior`) from a CREATE (leave the new site in place).
 */
export interface SiteRollbackEntry {
  siteName: string
  siteId: number | null
  existed: boolean
  prior: LiveSite | null
}

/**
 * Deploy Secret Server Distributed Engine sites over the REST API
 * (/api/v1/distributed-engine/site[s]):
 *   read:   GET   /distributed-engine/sites?filter.siteName=<name>  → match by name
 *   create: POST  /distributed-engine/site                          with { data: {...} }
 *   update: PATCH /distributed-engine/site/{id}                     with { data: { <field>: { dirty, value } } }
 *
 * Identity is siteName. rollbackData records, per site, the prior body (null
 * when it did not exist) AND its id — so rollback can restore the prior body,
 * or leave a newly created site in place (site deletion is not managed by
 * this app). On-premises Secret Server requires an existing Site Connector to
 * create a site; Secret Server Cloud subscriptions do not — a missing
 * connector surfaces as the underlying Secret Server error on create.
 *
 * NOTE: verified against the Delinea/Thycotic PowerShell module source;
 * verify request/response shapes against a live Secret Server 10.9.000064+.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiBase } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const specs = extractSiteSpecs(items).filter((s) => s.siteName)

  const previous: SiteRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      const matches = await searchSites(client, spec.siteName)
      const existing = findSiteByName(matches, spec.siteName)

      if (existing) {
        const siteId = siteIdOf(existing)
        if (siteId === null) throw new Error(`Site "${spec.siteName}" exists but has no usable id`)
        const res = await client.request('PATCH', `/distributed-engine/site/${siteId}`, { body: buildSiteUpdateBody(spec) })
        if (!res.ok) throw new Error(`Failed to update site "${spec.siteName}": ${secretServerErrorMessage(res)}`)
        previous.push({ siteName: spec.siteName, siteId, existed: true, prior: existing })
      } else {
        const res = await client.request('POST', '/distributed-engine/site', { body: buildSiteCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create site "${spec.siteName}": ${secretServerErrorMessage(res)}`)
        const created = parseJson<LiveSite>(res.body)
        previous.push({
          siteName: spec.siteName,
          siteId: created ? siteIdOf(created) : null,
          existed: false,
          prior: null,
        })
      }
      applied.push(spec.siteName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} site(s) to ${apiBase}: ${applied.join(', ') || '(none)'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Site deploy failed after ${applied.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  }
}
