import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { buildRoleFields, rolesFromList, findRole, type MispRole } from './_shared'

/**
 * Deploy MISP roles over the REST API (443):
 *   read (rollback): GET  /roles/index               → find the live role by name
 *   create:          POST /admin/roles/add             with { Role: {...} }
 *   update:          POST /admin/roles/edit/<id>        with { Role: {...} } (role exists)
 *
 * The name is the stable identity used to upsert. rollbackData records, per role,
 * the prior role body (null when it did not exist) AND the role id — a prior
 * body restores via edit; a newly created role (no prior body) is deleted on
 * rollback via /admin/roles/delete/<id> (MISP rejects deleting a role still
 * assigned to a user, which surfaces as a clear rollback failure).
 *
 * NOTE: verify /roles/index + /admin/roles/add + /admin/roles/edit/<id> +
 * /admin/roles/delete/<id> against a live MISP 2.4 instance.
 */
interface RoleMutationResponse {
  Role?: MispRole
}

async function listRoles(base: string, headers: Record<string, string>): Promise<MispRole[]> {
  try {
    return rolesFromList(await getJson<unknown>(`${base}/roles/index`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for role deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; roleId: number | string | null; role: MispRole | null }> = []
  const applied: string[] = []

  try {
    const live = await listRoles(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findRole(live, name)
      const body = { Role: buildRoleFields(item.fields) }

      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/admin/roles/edit/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, roleId: existing.id, role: existing })
      } else {
        const created = await sendJson<RoleMutationResponse>('POST', `${base}/admin/roles/add`, headers, body)
        const newId = created?.Role?.id ?? null
        previous.push({ name, roleId: newId, role: null })
      }
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
      message: `Role deploy failed after ${applied.length} role(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
