import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, s1ErrorMessage } from '../../lib/s1'
import { permissionsOf } from './deploy'
import type { RbacRoleRollbackEntry } from './deploy'

/**
 * Roll back RBAC roles using the state captured during deploy:
 *   - roles that were created are deleted (DELETE /rbac/roles)
 *   - roles that were updated are restored (PUT) to their prior full detail
 *     (name, description and the complete pre-deploy permission tree)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  const sf = client.scopeFilter()
  if (sf.error || !sf.filter) return { success: false, message: sf.error ?? 'scope not configured' }
  const filter = sf.filter

  const previousState = (ctx.rollbackData as { previousState?: RbacRoleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', '/rbac/roles', { body: { data: { ids: [entry.id] } } })
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete RBAC role "${entry.label}": ${s1ErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const restore = {
          id: entry.id,
          name: p.name ?? entry.label,
          description: p.description ?? '',
          permissions: permissionsOf(p),
        }
        const res = await client.request('PUT', '/rbac/roles', { body: { filter, data: restore } })
        if (!res.ok) {
          throw new Error(`Failed to restore RBAC role "${entry.label}": ${s1ErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} RBAC role(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
