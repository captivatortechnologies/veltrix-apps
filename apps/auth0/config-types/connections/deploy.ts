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
  buildConnectionCreateBody,
  buildConnectionUpdateBody,
  findConnectionByName,
  snapshotConnection,
  type Auth0Connection,
  type ConnectionUpdateBody,
} from './_shared'

/**
 * Deploy Auth0 Connections over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/connections     → match by name
 *   create:                     POST /api/v2/connections      with name + strategy + options
 *   update:                     PATCH /api/v2/connections/{id} with options only (name/strategy immutable)
 *
 * Upserts by NAME: list live connections, PATCH one with the same name else POST
 * a new one. rollbackData records, per connection, the prior managed body (null
 * when it did not exist) AND the id — so rollback restores the prior body or
 * deletes the one we created.
 */
interface ConnectionSummary {
  id?: string
  name?: string
}

const LIST_FIELDS = 'id,name,strategy,display_name,enabled_clients,options'

/** Read every live connection (paginated, best-effort) for name matching + rollback. */
async function listConnections(base: string, token: string): Promise<Auth0Connection[]> {
  const perPage = 100
  const all: Auth0Connection[] = []
  for (let page = 0; page < 50; page++) {
    const url = `${base}/connections?per_page=${perPage}&page=${page}&include_fields=true&fields=${encodeURIComponent(LIST_FIELDS)}`
    const batch = await getJson<Auth0Connection[]>(url, token)
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

  const previous: Array<{ name: string; connectionId: string | null; prior: ConnectionUpdateBody | null }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listConnections(base, accessToken)

    for (const item of items) {
      const name = readString(item.fields.name)
      if (!name) continue

      const existing = findConnectionByName(live, name)
      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/connections/${encodeURIComponent(existing.id)}`, accessToken, buildConnectionUpdateBody(item.fields))
        previous.push({ name, connectionId: existing.id, prior: snapshotConnection(existing) })
      } else {
        const created = await sendJson<ConnectionSummary>('POST', `${base}/connections`, accessToken, buildConnectionCreateBody(item.fields))
        previous.push({ name, connectionId: created?.id ?? null, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} connection(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 connection deploy failed after ${applied.length} connection(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
