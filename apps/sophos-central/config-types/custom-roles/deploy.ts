import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { createRole, listRoles, updateRole, type SophosRole } from '../../lib/sophosApi'
import { buildCustomRoleCreateBody, buildCustomRolePatchBody, customRoleKey, customRoleMatches, extractCustomRoleSpecs } from './_shared'

export interface CustomRoleRollbackEntry {
  name: string
  existed: boolean
  id?: string
  prior?: Pick<SophosRole, 'name' | 'description' | 'permissionSets'>
}

/**
 * Deploy Sophos Central custom roles, reconciled by NAME:
 *   list:   GET   /roles              -> find by name
 *   update: PATCH /roles/{id}          when found and different (principalType is immutable)
 *   create: POST  /roles               when not found
 *
 * The live list is read once and reused across every declared item.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractCustomRoleSpecs(ctx.canvas).filter((s) => s.name && s.principalType && s.permissionSets.length > 0)
  const previous: CustomRoleRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const live = await listRoles(client)
    const liveByName = new Map(live.filter((r) => r.name).map((r) => [customRoleKey(r.name), r] as const))

    for (const spec of specs) {
      const match = liveByName.get(customRoleKey(spec.name))

      if (!match) {
        const created = await createRole(client, buildCustomRoleCreateBody(spec))
        previous.push({ name: spec.name, existed: false, id: created.id })
      } else if (customRoleMatches(spec, match)) {
        previous.push({ name: spec.name, existed: true, id: match.id, prior: match })
      } else {
        if (match.id) await updateRole(client, match.id, buildCustomRolePatchBody(spec))
        previous.push({ name: spec.name, existed: true, id: match.id, prior: match })
      }
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} custom role(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom role deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
