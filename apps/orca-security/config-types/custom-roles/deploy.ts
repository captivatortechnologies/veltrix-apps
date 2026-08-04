import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { priorServerId, readPriorRollback } from '../../lib/reconcile'
import {
  buildCustomRoleBody,
  customRoleFromEnvelope,
  type CustomRoleRollbackData,
  type CustomRoleRollbackEntry,
  type OrcaCustomRole,
} from './_shared'

/**
 * Deploy Orca custom roles over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   read (update/restore): GET  /api/rbac/roles/{id}
 *   create:                POST /api/rbac/roles            -> { data: { id } }
 *   update:                PUT  /api/rbac/roles/{id}
 *
 * The general role list (/api/rbac/role, singular — used to resolve a role for
 * ASSIGNMENT purposes) is a different, unpaginated endpoint mixing built-in
 * and custom roles with no documented shape guarantee, so this app does not
 * treat it as a reliable "list my managed roles" fallback. Identity is instead
 * the role id this app assigns on create and persists in rollbackData —
 * recovered on the next deploy by the stable canvas item id first (so a rename
 * updates the same role) then by name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback<OrcaCustomRole>(ctx)

  const previous: CustomRoleRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const knownId = priorServerId(previousData.previous, itemId, name)
      const prior = knownId ? await readCustomRole(client, knownId) : null

      if (knownId && prior) {
        const body = buildCustomRoleBody(item.fields, knownId)
        const res = await client.request<unknown>('PUT', `/api/rbac/roles/${encodeURIComponent(knownId)}`, body)
        if (res.error) throw new Error(`update custom role "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, serverId: knownId, existed: true, prior })
      } else {
        const body = buildCustomRoleBody(item.fields)
        const res = await client.request<unknown>('POST', '/api/rbac/roles', body)
        if (res.error) throw new Error(`create custom role "${name}" failed: ${res.error}`)
        const created = customRoleFromEnvelope(res.data)
        const newId = created?.id ?? null
        previous.push({ itemId, name, serverId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom role(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies CustomRoleRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Custom role deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies CustomRoleRollbackData,
    }
  }
}

/** GET one custom role by id, returning its body or null when gone / unreadable. */
async function readCustomRole(client: OrcaClient, id: string): Promise<OrcaCustomRole | null> {
  const res = await client.request<unknown>('GET', `/api/rbac/roles/${encodeURIComponent(id)}`)
  if (res.error) return null
  return customRoleFromEnvelope(res.data)
}
