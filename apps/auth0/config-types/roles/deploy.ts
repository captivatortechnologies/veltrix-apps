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
  buildRoleBody,
  findRoleByName,
  parsePermissions,
  type Auth0Permission,
  type Auth0Role,
  type RoleBody,
} from './_shared'
import { getRolePermissions, reconcileRolePermissions } from './permissions'

/**
 * Deploy Auth0 Roles over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/roles          → match by name
 *   create:                     POST /api/v2/roles           with name + description
 *   update:                     PATCH /api/v2/roles/{id}     with name + description
 *   permissions:                reconcile /roles/{id}/permissions to the declared grants
 *
 * Upserts by NAME. rollbackData records, per role, the prior role body (null when
 * it did not exist), the prior permission grants, AND the id — so rollback restores
 * the prior state or deletes the role we created.
 */
interface RoleSummary {
  id?: string
  name?: string
}

/** Read every live role (paginated, best-effort) for name matching + rollback. */
async function listRoles(base: string, token: string): Promise<Auth0Role[]> {
  const perPage = 100
  const all: Auth0Role[] = []
  for (let page = 0; page < 50; page++) {
    const url = `${base}/roles?per_page=${perPage}&page=${page}`
    const batch = await getJson<Auth0Role[]>(url, token)
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

  const previous: Array<{
    name: string
    roleId: string | null
    priorRole: RoleBody | null
    priorPermissions: Auth0Permission[]
  }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listRoles(base, accessToken)

    for (const item of items) {
      const name = readString(item.fields.name)
      if (!name) continue

      const desired = parsePermissions(item.fields.permissions)
      const existing = findRoleByName(live, name)

      let roleId: string | null
      if (existing && existing.id) {
        roleId = existing.id
        const priorPermissions = await getRolePermissions(base, roleId, accessToken)
        await sendJson('PATCH', `${base}/roles/${encodeURIComponent(roleId)}`, accessToken, buildRoleBody(item.fields))
        previous.push({
          name,
          roleId,
          priorRole: { name: String(existing.name ?? name), description: typeof existing.description === 'string' ? existing.description : '' },
          priorPermissions,
        })
      } else {
        const created = await sendJson<RoleSummary>('POST', `${base}/roles`, accessToken, buildRoleBody(item.fields))
        roleId = created?.id ?? null
        previous.push({ name, roleId, priorRole: null, priorPermissions: [] })
      }

      if (roleId) await reconcileRolePermissions(base, roleId, accessToken, desired)
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} role(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 role deploy failed after ${applied.length} role(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
