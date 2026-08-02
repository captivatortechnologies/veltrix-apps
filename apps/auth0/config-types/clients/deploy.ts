import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
  sendJson,
} from '../../lib/auth0Api'
import {
  buildClientBody,
  findClientByName,
  snapshotManagedFields,
  type Auth0Client,
  type Auth0ClientBody,
} from './_shared'

/**
 * Deploy Auth0 Applications (Clients) over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/clients        → match by name
 *   create:                     POST /api/v2/clients         with the client body
 *   update:                     PATCH /api/v2/clients/{id}   with the client body
 *
 * The Management API keys clients on the server-assigned `client_id`, so this
 * config type upserts by NAME: list the live clients, find one with the same
 * name, PATCH it if found else POST a new one. rollbackData records, per client,
 * the prior managed body (null when it did not exist) AND the client_id — so
 * rollback restores the prior body or deletes the one we created.
 */
interface FieldSummaryClient {
  client_id?: string
  name?: string
}

/** Managed fields to read back for identity matching + rollback snapshots. */
const LIST_FIELDS =
  'client_id,name,app_type,callbacks,allowed_logout_urls,web_origins,grant_types,token_endpoint_auth_method'

/** Read every live client (paginated, best-effort) for name matching + rollback. */
async function listClients(base: string, token: string): Promise<Auth0Client[]> {
  const perPage = 100
  const all: Auth0Client[] = []
  for (let page = 0; page < 50; page++) {
    const url = `${base}/clients?per_page=${perPage}&page=${page}&include_fields=true&fields=${encodeURIComponent(LIST_FIELDS)}`
    const batch = await getJson<Auth0Client[]>(url, token)
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

  const previous: Array<{ name: string; clientId: string | null; prior: Auth0ClientBody | null }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listClients(base, accessToken)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const body = buildClientBody(item.fields)
      const existing = findClientByName(live, name)

      if (existing && existing.client_id) {
        await sendJson('PATCH', `${base}/clients/${encodeURIComponent(existing.client_id)}`, accessToken, body)
        previous.push({ name, clientId: existing.client_id, prior: snapshotManagedFields(existing) })
      } else {
        const created = await sendJson<FieldSummaryClient>('POST', `${base}/clients`, accessToken, body)
        previous.push({ name, clientId: created?.client_id ?? null, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} application(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 application deploy failed after ${applied.length} application(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
