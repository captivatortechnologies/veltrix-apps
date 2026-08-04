import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient, umbrellaErrorMessage } from '../../lib/umbrellaApi'
import { DEPLOYMENTS_TUNNELS_PATH } from '../../lib/deployments'
import type { TunnelRollbackEntry } from './deploy'

/**
 * Undo a network-tunnels deploy from rollbackData.entries:
 *   created (existed false): delete the tunnel we created.
 *   updated (existed true):  nothing to restore — tunnels have no update
 *                            endpoint, so this deploy never changed them.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const data = ctx.rollbackData as { entries?: TunnelRollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  if (entries.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const failures: string[] = []
  let deleted = 0
  const untouched = entries.filter((e) => e.existed).length

  for (const e of entries) {
    if (e.existed || e.tunnelId == null) continue
    const res = await client.delete(`${DEPLOYMENTS_TUNNELS_PATH}/${encodeURIComponent(String(e.tunnelId))}`)
    if (!res.ok && res.status !== 404) failures.push(`delete tunnel "${e.name}": ${umbrellaErrorMessage(res)}`)
    else deleted++
  }

  if (failures.length) return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  const untouchedSuffix = untouched ? ` ${untouched} pre-existing tunnel(s) were left untouched (no update endpoint).` : ''
  return { success: true, message: `Rolled back tunnels: ${deleted} deleted.${untouchedSuffix}` }
}
