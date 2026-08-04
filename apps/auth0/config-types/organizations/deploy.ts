import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, listAllPages, sendJson } from '../../lib/auth0Api'
import { readString } from '../../lib/fields'
import {
  buildOrganizationCreateBody,
  buildOrganizationUpdateBody,
  findOrganizationByName,
  parseEnabledConnections,
  snapshotOrganization,
  type Auth0Organization,
  type EnabledConnectionSpec,
  type OrganizationUpdateBody,
} from './_shared'
import { getEnabledConnections, reconcileEnabledConnections } from './connections'

/**
 * Deploy Auth0 Organizations over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/organizations       → match by name
 *   create:                     POST /api/v2/organizations        with name + the managed fields
 *   update:                     PATCH /api/v2/organizations/{id}  with the managed fields (name immutable)
 *   enabled connections:        reconcile /organizations/{id}/enabled_connections to the declared list
 *
 * Upserts by NAME. rollbackData records, per organization, the prior body (null
 * when it did not exist), the prior enabled connections, AND the id — so
 * rollback restores the prior state or deletes the organization we created.
 */
interface OrganizationSummary {
  id?: string
  name?: string
}

async function listOrganizations(base: string, token: string): Promise<Auth0Organization[]> {
  return listAllPages<Auth0Organization>((page) => `${base}/organizations?per_page=100&page=${page}`, token)
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

  const previous: Array<{
    name: string
    orgId: string | null
    priorOrg: OrganizationUpdateBody | null
    priorConnections: EnabledConnectionSpec[]
  }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listOrganizations(base, accessToken)

    for (const item of items) {
      const name = readString(item.fields.name)
      if (!name) continue

      const desiredConnections = parseEnabledConnections(item.fields.enabled_connections)
      const existing = findOrganizationByName(live, name)

      let orgId: string | null
      if (existing && existing.id) {
        orgId = existing.id
        const priorConnections = await getEnabledConnections(base, orgId, accessToken)
        await sendJson('PATCH', `${base}/organizations/${encodeURIComponent(orgId)}`, accessToken, buildOrganizationUpdateBody(item.fields))
        previous.push({ name, orgId, priorOrg: snapshotOrganization(existing), priorConnections })
      } else {
        const created = await sendJson<OrganizationSummary>('POST', `${base}/organizations`, accessToken, buildOrganizationCreateBody(item.fields))
        orgId = created?.id ?? null
        previous.push({ name, orgId, priorOrg: null, priorConnections: [] })
      }

      if (orgId) await reconcileEnabledConnections(base, orgId, accessToken, desiredConnections)
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} organization(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 organization deploy failed after ${applied.length} organization(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
