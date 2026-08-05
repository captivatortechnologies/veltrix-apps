import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, listAll, sendJson } from '../../lib/soarApi'
import { buildRoleRecord, findRoleByName, type SoarRole } from './_shared'

/**
 * Deploy roles over the SOAR REST API (443):
 *   read (upsert lookup): GET  /rest/role?page_size=0 → find the live role by name
 *   create:                POST /rest/role             with { name, description, permissions }
 *   update:                POST /rest/role/<id>          (role exists — full replace)
 *
 * The name is the stable identity used to upsert. rollbackData records, per
 * role, the prior role body (null when it did not exist) and its numeric id —
 * a prior body restores via POST /<id>; a newly-created role (no prior body)
 * is deleted on rollback via DELETE /rest/role/<id>.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: 'Missing credential for role deployment' }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; roleId: number | string | null; role: SoarRole | null }> = []
  const applied: string[] = []

  try {
    const live = await listAll<SoarRole>(base, headers, 'role')

    for (const item of items) {
      const spec = buildRoleRecord(item.fields)
      if (!spec.id || !spec.body) continue

      const existing = findRoleByName(live, spec.id)
      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/rest/role/${encodeURIComponent(String(existing.id))}`, headers, spec.body)
        previous.push({ name: spec.id, roleId: existing.id, role: existing })
      } else {
        const created = await sendJson<{ id?: number | string }>('POST', `${base}/rest/role`, headers, spec.body)
        previous.push({ name: spec.id, roleId: created?.id ?? null, role: null })
      }
      applied.push(spec.id)
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
