import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildRoleBody, rolesFromList, findRole, type GraylogRole } from './_shared'

/**
 * Deploy Graylog roles over the REST API:
 *   read (rollback): GET  /api/roles          → find the live role by name
 *   create:          POST /api/roles           → RoleResponse
 *   update:          PUT  /api/roles/{name}    → RoleResponse
 *
 * The role NAME is the stable identity used to upsert. A live role that is
 * `read_only` (Graylog's built-in "Admin"/"Reader") fails that item's deploy
 * loudly rather than attempting a write Graylog would reject. rollbackData
 * records, per role, the prior role (null when it did not exist) — so
 * rollback can restore the prior permission set or delete the one we created.
 */
async function listRoles(base: string, headers: Record<string, string>): Promise<GraylogRole[]> {
  try {
    return rolesFromList(await getJson<unknown>(`${base}/api/roles`, headers))
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

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; role: GraylogRole | null }> = []
  const applied: string[] = []

  try {
    const live = await listRoles(base, headers)

    for (const item of items) {
      const name = asString(item.fields.name)
      if (!name) continue

      const { body, error } = buildRoleBody(item.fields)
      if (error || !body) throw new Error(`Role "${name}": ${error ?? 'could not build request body'}`)

      const existing = findRole(live, name)
      if (existing?.read_only) {
        throw new Error(`Role "${name}" is a built-in read-only Graylog role and cannot be modified.`)
      }

      if (existing) {
        await sendJson('PUT', `${base}/api/roles/${encodeURIComponent(name)}`, headers, body)
        previous.push({ name, role: existing })
      } else {
        await sendJson('POST', `${base}/api/roles`, headers, body)
        previous.push({ name, role: null })
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
