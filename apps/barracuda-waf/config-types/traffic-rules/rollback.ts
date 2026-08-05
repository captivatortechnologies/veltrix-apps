import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import type { TrafficRuleRollbackEntry, TrafficRulesRollbackData } from './deploy'
import { trafficRulePath } from './validate'

/**
 * Roll back Traffic Rules using the state captured during deploy:
 *   - rules that were CREATED are deleted
 *   - rules that were UPDATED are restored to their prior body (PUT)
 *   - rules that were DELETED (no longer declared) are recreated (POST)
 * Applied in reverse order of the deploy.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, appName } = built

  const data = ctx.rollbackData as TrafficRulesRollbackData | undefined
  if (!data?.entries || data.entries.length === 0) {
    return { success: true, message: 'Nothing to roll back — this deploy changed no Traffic Rules.' }
  }

  let reverted = 0
  const skipped: string[] = []

  try {
    for (const entry of [...data.entries].reverse() as TrafficRuleRollbackEntry[]) {
      if (entry.action === 'created') {
        const res = await client.request('DELETE', trafficRulePath(client, appName, entry.name))
        if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete Traffic Rule "${entry.name}": ${barracudaErrorMessage(res)}`)
      } else if (entry.action === 'updated') {
        const res = await client.request('PUT', trafficRulePath(client, appName, entry.name), { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore Traffic Rule "${entry.name}": ${barracudaErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', `${client.appPath(appName)}/traffic_rules/`, { body: entry.prior })
        if (!res.ok) {
          skipped.push(entry.name)
          continue
        }
      }
      reverted++
    }

    const skippedNote = skipped.length > 0 ? ` (failed to recreate ${skipped.length}: ${skipped.join(', ')})` : ''
    return { success: skipped.length === 0, message: `Rolled back ${reverted} Traffic Rule change(s)${skippedNote}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed after ${reverted} of ${data.entries.length}: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
