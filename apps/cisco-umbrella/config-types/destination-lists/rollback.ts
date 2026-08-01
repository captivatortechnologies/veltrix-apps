import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient, umbrellaErrorMessage } from '../../lib/umbrellaApi'
import { listPath, syncDestinations } from './_shared'
import type { RollbackEntry } from './deploy'

/**
 * Undo a destination-lists deploy from rollbackData.entries (written by deploy):
 *   created (existed false): delete the list we created.
 *   updated (existed true):  restore the prior name and sync destinations back
 *                            to the prior set captured at deploy time.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  if (entries.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (e.listId == null) continue
    if (!e.existed) {
      const res = await client.delete(listPath(e.listId))
      if (!res.ok && res.status !== 404) failures.push(`delete ${e.name}: ${umbrellaErrorMessage(res)}`)
      else deleted++
    } else if (e.prior) {
      if (e.prior.name && e.prior.name !== e.name) {
        const renamed = await client.patch(listPath(e.listId), { name: e.prior.name })
        if (!renamed.ok) failures.push(`restore name ${e.name}: ${umbrellaErrorMessage(renamed)}`)
      }
      const sync = await syncDestinations(client, e.listId, e.prior.destinations)
      if (sync.errors.length) failures.push(`restore ${e.name}: ${sync.errors.join('; ')}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back destination lists: ${deleted} deleted, ${restored} restored.` }
}
