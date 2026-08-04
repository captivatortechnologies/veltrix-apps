import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_ROLE_MUTATION,
  LIST_ROLES_QUERY,
  PATCH_ROLE_MUTATION,
  buildRoleInput,
  buildRolePatch,
  findRole,
  rolesFromList,
  type OpenctiRole,
} from './_shared'

/**
 * Deploy OpenCTI RBAC roles over the GraphQL API:
 *   read (rollback): roles                      → find the live role by name
 *   create:          roleAdd(input) with { name, description? }
 *   update:          roleEdit(id) { fieldPatch(input) } with [EditInput] (role exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per role,
 * the prior role node (null when it did not exist) AND the role id — so rollback
 * can restore the prior body or delete the one we created.
 *
 * NOTE: roleAdd returns the created role (with its new id).
 */
async function listRoles(base: string, headers: Record<string, string>): Promise<OpenctiRole[]> {
  try {
    return rolesFromList(await graphql<unknown>(base, headers, LIST_ROLES_QUERY))
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

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; roleId: string | null; role: OpenctiRole | null }> = []
  const applied: string[] = []

  try {
    const live = await listRoles(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findRole(live, name)

      if (existing && existing.id != null) {
        const input = buildRolePatch(item.fields)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_ROLE_MUTATION, { id: existing.id, input })
        }
        previous.push({ name, roleId: String(existing.id), role: existing })
      } else {
        const created = await graphql<{ roleAdd?: OpenctiRole }>(base, headers, ADD_ROLE_MUTATION, {
          input: buildRoleInput(item.fields),
        })
        const newId = created?.roleAdd?.id ?? null
        previous.push({ name, roleId: newId ? String(newId) : null, role: null })
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
