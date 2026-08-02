import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
  sendJson,
} from '../../lib/auth0Api'
import { readString } from '../../lib/fields'
import {
  buildResourceServerCreateBody,
  buildResourceServerUpdateBody,
  findResourceServerByName,
  snapshotResourceServer,
  type Auth0ResourceServer,
  type ResourceServerUpdateBody,
} from './_shared'

/**
 * Deploy Auth0 Resource Servers (APIs) over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/resource-servers      → match by name
 *   create:                     POST /api/v2/resource-servers        with name + identifier + scopes
 *   update:                     PATCH /api/v2/resource-servers/{id}  without identifier (immutable)
 *
 * Upserts by NAME: list live resource servers, PATCH one with the same name else
 * POST a new one. rollbackData records, per API, the prior managed body (null when
 * it did not exist) AND the id — so rollback restores the prior body or deletes the
 * one we created.
 */
interface ResourceServerSummary {
  id?: string
  name?: string
}

const LIST_FIELDS = 'id,name,identifier,scopes,signing_alg,token_lifetime'

/** Read every live resource server (paginated, best-effort) for matching + rollback. */
async function listResourceServers(base: string, token: string): Promise<Auth0ResourceServer[]> {
  const perPage = 100
  const all: Auth0ResourceServer[] = []
  for (let page = 0; page < 50; page++) {
    const url = `${base}/resource-servers?per_page=${perPage}&page=${page}&include_fields=true&fields=${encodeURIComponent(LIST_FIELDS)}`
    const batch = await getJson<Auth0ResourceServer[]>(url, token)
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < perPage) break
  }
  return all
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  const previous: Array<{ name: string; resourceServerId: string | null; prior: ResourceServerUpdateBody | null }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listResourceServers(base, accessToken)

    for (const item of items) {
      const name = readString(item.fields.name)
      if (!name) continue

      const existing = findResourceServerByName(live, name)
      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/resource-servers/${encodeURIComponent(existing.id)}`, accessToken, buildResourceServerUpdateBody(item.fields))
        previous.push({ name, resourceServerId: existing.id, prior: snapshotResourceServer(existing) })
      } else {
        const created = await sendJson<ResourceServerSummary>('POST', `${base}/resource-servers`, accessToken, buildResourceServerCreateBody(item.fields))
        previous.push({ name, resourceServerId: created?.id ?? null, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} API(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 resource server deploy failed after ${applied.length} API(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
