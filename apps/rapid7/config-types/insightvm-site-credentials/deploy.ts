import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildInsightVMClient,
  insightVMErrorMessage,
  parseJson,
  type InsightVMClient,
} from '../../lib/insightvm'
import {
  credentialKey,
  extractSiteCredentialSpecs,
  parseJsonObject,
  type LiveSiteCredential,
  type SiteCredentialSpec,
} from './validate'

/**
 * Rollback state for one site credential. `prior` carries ONLY the non-secret
 * fields captured before an update — the write-only account password is never
 * read back or stored (the API masks it anyway), so a restored credential keeps
 * whatever secret it had at update time.
 */
export interface SiteCredentialRollbackEntry {
  key: string
  label: string
  siteId: number
  existed: boolean
  id?: number
  prior?: { name?: string; description?: string; account?: Record<string, unknown> }
}

/**
 * Deploy Rapid7 InsightVM per-site credentials. Each credential is a child of a
 * site: the handler resolves the site by name, lists its credentials, matches by
 * credential name, then POSTs a new credential or PUTs an existing one. Identity
 * is (site name, credential name).
 *
 * ⚠ The account password (the `secret` field) is WRITE-ONLY. It is NEVER read
 * back, diffed or stored; it is sent on BOTH create and update so the live
 * credential always carries the secret the canvas declares.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, consoleUrl } = built

  const specs = extractSiteCredentialSpecs(ctx.canvas).filter((s) => s.siteName && s.name)
  const rollbackState: SiteCredentialRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const siteIds = new Map<string, number>()

    for (const spec of specs) {
      const label = `${spec.name} @ ${spec.siteName}`
      const siteId = await resolveSiteId(client, spec.siteName, siteIds)

      const existing = await listSiteCredentials(client, siteId)
      const live = existing.find((c) => (c.name ?? '').toLowerCase() === spec.name.toLowerCase())
      const key = credentialKey(spec)

      if (live && live.id != null) {
        rollbackState.push({ key, label, siteId, existed: true, id: live.id, prior: priorNonSecret(live) })
        const res = await client.request('PUT', `/sites/${siteId}/site_credentials/${live.id}`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to update credential "${label}": ${insightVMErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', `/sites/${siteId}/site_credentials`, { body: buildBody(spec) })
        if (!res.ok) throw new Error(`Failed to create credential "${label}": ${insightVMErrorMessage(res)}`)
        const created = parseJson<{ id?: number }>(res.body)
        if (created?.id == null) throw new Error(`Credential "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, siteId, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} site credential(s) to ${consoleUrl}: ${deployed.join(', ')}`,
      artifacts: { consoleUrl, deployedCredentials: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Site credential deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { consoleUrl, deployedCredentials: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

interface LiveSite {
  id?: number
  name?: string
}

/** Resolve a site name to its id (cached); throws when the site is not found. */
export async function resolveSiteId(client: InsightVMClient, name: string, cache: Map<string, number>): Promise<number> {
  const cached = cache.get(name.toLowerCase())
  if (cached !== undefined) return cached
  const res = await client.getAll<LiveSite>('/sites')
  if (!res.ok) {
    throw new Error(`Failed to list sites while resolving "${name}": ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  for (const site of res.items) {
    if (site.name && site.id != null) cache.set(site.name.toLowerCase(), site.id)
  }
  const id = cache.get(name.toLowerCase())
  if (id === undefined) throw new Error(`Site "${name}" not found — create the site before managing credentials on it`)
  return id
}

/** List a site's credentials; throws on a non-OK response. */
export async function listSiteCredentials(client: InsightVMClient, siteId: number): Promise<LiveSiteCredential[]> {
  const res = await client.getAll<LiveSiteCredential>(`/sites/${siteId}/site_credentials`)
  if (!res.ok) {
    throw new Error(`Failed to list site credentials for site ${siteId}: ${insightVMErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/**
 * Build the create/update body. The account is the parsed credential JSON (the
 * account WITHOUT its secret) with the write-only password merged on top. The
 * secret is always sent — the API masks it on read, so a deploy that omitted it
 * would blank the stored secret.
 */
function buildBody(spec: SiteCredentialSpec): Record<string, unknown> {
  const account = parseJsonObject(spec.credentialJson).value ?? {}
  return {
    name: spec.name,
    description: spec.description,
    account: { ...account, password: spec.secret },
  }
}

/**
 * Capture a live credential's NON-secret fields for rollback. The account's
 * `password` is stripped so the write-only secret is never stored in
 * rollbackData (it is masked on read anyway and must not be trusted).
 */
function priorNonSecret(live: LiveSiteCredential): SiteCredentialRollbackEntry['prior'] {
  let account: Record<string, unknown> | undefined
  if (live.account && typeof live.account === 'object') {
    account = Object.fromEntries(Object.entries(live.account).filter(([k]) => k !== 'password'))
  }
  return { name: live.name, description: live.description, account }
}
