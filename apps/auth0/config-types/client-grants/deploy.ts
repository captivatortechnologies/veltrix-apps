import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  sendJson,
  listAllPages,
} from '../../lib/auth0Api'
import { readString } from '../../lib/fields'
import {
  buildClientGrantCreateBody,
  buildClientGrantUpdateBody,
  findClientGrant,
  grantKey,
  snapshotClientGrant,
  type Auth0ClientGrant,
  type ClientGrantUpdateBody,
} from './_shared'

/**
 * Deploy Auth0 Client Grants over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/client-grants     → match by (client_id, audience)
 *   create:                     POST /api/v2/client-grants      with client_id + audience + scope + org fields
 *   update:                     PATCH /api/v2/client-grants/{id} without client_id/audience (immutable)
 *
 * Upserts by the COMPOSITE (client_id, audience) pair — this resource has no
 * single unique field. rollbackData records, per grant, the prior managed body
 * (null when it did not exist) AND the id — so rollback restores the prior
 * body or deletes the one we created.
 */
interface ClientGrantSummary {
  id?: string
  client_id?: string
  audience?: string
}

const LIST_FIELDS = 'id,client_id,audience,scope,organization_usage,allow_any_organization'

/** Read every live client grant (paginated) for (client_id, audience) matching + rollback. */
async function listClientGrants(base: string, token: string): Promise<Auth0ClientGrant[]> {
  return listAllPages<Auth0ClientGrant>(
    (page) => `${base}/client-grants?per_page=100&page=${page}&include_fields=true&fields=${encodeURIComponent(LIST_FIELDS)}`,
    token,
  )
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

  const previous: Array<{ key: string; grantId: string | null; prior: ClientGrantUpdateBody | null }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listClientGrants(base, accessToken)

    for (const item of items) {
      const clientId = readString(item.fields.client_id)
      const audience = readString(item.fields.audience)
      if (!clientId || !audience) continue

      const key = grantKey(clientId, audience)
      const existing = findClientGrant(live, clientId, audience)
      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/client-grants/${encodeURIComponent(existing.id)}`, accessToken, buildClientGrantUpdateBody(item.fields))
        previous.push({ key, grantId: existing.id, prior: snapshotClientGrant(existing) })
      } else {
        const created = await sendJson<ClientGrantSummary>('POST', `${base}/client-grants`, accessToken, buildClientGrantCreateBody(item.fields))
        previous.push({ key, grantId: created?.id ?? null, prior: null })
      }
      applied.push(key)
    }

    return {
      success: true,
      message: `Applied ${applied.length} client grant(s)`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 client grant deploy failed after ${applied.length} grant(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
