import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, listPaged, sendJson } from '../../lib/sumoLogicApi'
import { buildRoleBody, findRole, type Role } from './_shared'

/**
 * Deploy Sumo Logic roles over the Management API (HTTPS):
 *   read (upsert/rollback): GET  /roles                → { data: [...], next } (paged)
 *   create:                 POST /roles                with { name, description, filterPredicate, capabilities }
 *   update:                 PUT  /roles/<id>            with the same body (id lives in the path)
 *
 * The role NAME is the stable identity used to upsert. rollbackData records, per
 * role, the prior role body (null when it did not exist) AND the role id — so
 * rollback can restore the prior body or delete the one we created. User
 * membership is not managed here (the body omits `users`), so existing members
 * are preserved.
 *
 * API: https://www.sumologic.com/help/docs/api/role-management-v2/
 * Endpoints verified against the SumoLogic terraform provider
 * (sumologic/sumologic_role.go).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for role deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; roleId: string | null; role: Role | null }> = []
  const applied: string[] = []

  let live: Role[] = []
  try {
    live = await listPaged<Role>(base, 'roles', headers)
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findRole(live, name)
      const body = buildRoleBody(item.fields)

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/roles/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, roleId: String(existing.id), role: existing })
      } else {
        const created = await sendJson<Role>('POST', `${base}/roles`, headers, body)
        previous.push({ name, roleId: created?.id != null ? String(created.id) : null, role: null })
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
