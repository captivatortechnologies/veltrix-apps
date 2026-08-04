import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { toUpdatePayload } from './_shared'
import { revokePermission } from './permissions'
import type { RoleRollbackEntry } from './deploy'

const ROLES_PATH = '/api/v2/roles'

/**
 * Roll back Roles using the state captured during deploy:
 *   - roles that were CREATED are deleted (DELETE .../{id}; 404 tolerated —
 *     this also removes every permission grant on the role, including the
 *     ones this deploy granted, so no separate revoke step is needed).
 *   - roles that were UPDATED are restored: the name is PATCHed back to its
 *     prior value, and exactly the permissions THIS deploy granted are
 *     revoked (permission grants are additive-only — see permissions.ts — so
 *     nothing else is touched: a Datadog baseline default or a permission a
 *     human granted out-of-band is left alone).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RoleRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.request('DELETE', `${ROLES_PATH}/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete role "${entry.label}": ${datadogErrorMessage(res)}`)
        }
      } else {
        if (entry.priorName) {
          const res = await client.request('PATCH', `${ROLES_PATH}/${encodeURIComponent(entry.id)}`, {
            body: toUpdatePayload(entry.id, { name: entry.priorName }),
          })
          if (!res.ok) throw new Error(`Failed to restore role "${entry.label}" name: ${datadogErrorMessage(res)}`)
        }
        for (const permissionId of entry.grantedPermissionIds) {
          await revokePermission(client, entry.id, permissionId)
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Role(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
