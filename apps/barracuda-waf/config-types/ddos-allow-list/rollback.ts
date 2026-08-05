import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import { allowListItemPath, type AllowListRollbackEntry, type DdosAllowListRollbackData } from './deploy'
import { buildAllowListBody } from './validate'

/**
 * Roll back the DDoS allow list using the state captured during deploy:
 *   - entries that were CREATED are deleted
 *   - entries that were UPDATED are restored to their prior body (PATCH)
 *   - entries that were DELETED (no longer declared) are recreated (POST)
 * Applied in reverse order of the deploy.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, appName } = built

  const data = ctx.rollbackData as DdosAllowListRollbackData | undefined
  if (!data?.entries || data.entries.length === 0) {
    return { success: true, message: 'Nothing to roll back — this deploy changed no allow-list entries.' }
  }

  let reverted = 0
  const skipped: string[] = []

  try {
    for (const entry of [...data.entries].reverse() as AllowListRollbackEntry[]) {
      if (entry.action === 'created') {
        const res = await client.request('DELETE', allowListItemPath(client, appName, entry.id))
        if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete allow-list entry "${entry.ip}": ${barracudaErrorMessage(res)}`)
      } else if (entry.action === 'updated') {
        const body = buildAllowListBody({
          sectionName: '',
          ip: entry.prior.ip ?? entry.ip,
          netmask: entry.prior.netmask ?? '255.255.255.255',
          note: entry.prior.note ?? '',
          allowBypass: entry.prior.allow_bypass ?? false,
        })
        const res = await client.request('PATCH', allowListItemPath(client, appName, entry.id), { body })
        if (!res.ok) throw new Error(`Failed to restore allow-list entry "${entry.ip}": ${barracudaErrorMessage(res)}`)
      } else {
        const body = buildAllowListBody({
          sectionName: '',
          ip: entry.prior.ip ?? entry.ip,
          netmask: entry.prior.netmask ?? '255.255.255.255',
          note: entry.prior.note ?? '',
          allowBypass: entry.prior.allow_bypass ?? false,
        })
        const res = await client.request('POST', `${client.appPath(appName)}/ddos/allow_list/`, { body })
        if (!res.ok) {
          skipped.push(entry.ip)
          continue
        }
      }
      reverted++
    }

    const skippedNote = skipped.length > 0 ? ` (failed to recreate ${skipped.length}: ${skipped.join(', ')})` : ''
    return { success: skipped.length === 0, message: `Rolled back ${reverted} DDoS allow-list entry change(s)${skippedNote}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed after ${reverted} of ${data.entries.length}: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
