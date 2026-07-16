import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import { extractSiteSpecs, siteKey, type LiveSite, type SiteSpec } from './validate'

export interface SiteRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: number
  prior?: LiveSite
}

/**
 * Deploy Rapid7 InsightVM scan sites via the Console API.
 *
 * Identity is the site name: list /sites, match on the name, then PUT an existing
 * site by id (full replace) or POST a new one. The created site's id is at the top
 * level of the POST response body.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractSiteSpecs(ctx.canvas).filter((s) => s.name && s.includedAddresses.length > 0)
  const rollbackState: SiteRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listSites(client)
    const byKey = new Map(existing.filter((s) => s.name).map((s) => [siteKey({ name: s.name as string }), s]))

    for (const spec of specs) {
      const label = spec.name
      const key = siteKey(spec)
      const live = byKey.get(key)

      if (live && live.id != null) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/sites/${live.id}`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to update site "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/sites', { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create site "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Site "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} site(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedSites: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Site deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedSites: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all sites; throws on a non-OK response. */
export async function listSites(client: InsightVMClient): Promise<LiveSite[]> {
  const res = await client.getAll<LiveSite>('/sites')
  if (!res.ok) {
    throw new Error(`Failed to list sites: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/**
 * Build the /sites request body. engineId (number) and scanTemplateId (string) are
 * omitted when unset/blank; excludedTargets is omitted when there are no exclusions.
 */
function buildBody(spec: SiteSpec): Record<string, unknown> {
  const assets: Record<string, unknown> = {
    includedTargets: { addresses: spec.includedAddresses },
  }
  if (spec.excludedAddresses.length > 0) {
    assets.excludedTargets = { addresses: spec.excludedAddresses }
  }

  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    importance: spec.importance,
    scan: { assets },
  }
  if (spec.engineId !== undefined) body.engineId = spec.engineId
  if (spec.scanTemplateId) body.scanTemplateId = spec.scanTemplateId
  return body
}
