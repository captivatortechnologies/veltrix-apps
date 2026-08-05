import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage } from '../../lib/barracudaWaf'
import type { ResponsePageRollbackEntry, ResponsePagesRollbackData } from './deploy'
import { responsePagePath } from './validate'

/**
 * Roll back Response Pages using the state captured during deploy:
 *   - pages that were CREATED are deleted
 *   - pages that were UPDATED are restored to their prior body (PUT)
 *   - pages that were DELETED (no longer declared) are recreated (POST)
 * Applied in reverse order of the deploy.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, appName } = built

  const data = ctx.rollbackData as ResponsePagesRollbackData | undefined
  if (!data?.entries || data.entries.length === 0) {
    return { success: true, message: 'Nothing to roll back — this deploy changed no Response Pages.' }
  }

  let reverted = 0
  const skipped: string[] = []

  try {
    for (const entry of [...data.entries].reverse() as ResponsePageRollbackEntry[]) {
      if (entry.action === 'created') {
        const res = await client.request('DELETE', responsePagePath(client, appName, entry.name))
        if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete Response Page "${entry.name}": ${barracudaErrorMessage(res)}`)
      } else if (entry.action === 'updated') {
        const res = await client.request('PUT', responsePagePath(client, appName, entry.name), { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore Response Page "${entry.name}": ${barracudaErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', `${client.appPath(appName)}/response_page_component/pages/`, { body: entry.prior })
        if (!res.ok) {
          skipped.push(entry.name)
          continue
        }
      }
      reverted++
    }

    const skippedNote = skipped.length > 0 ? ` (failed to recreate ${skipped.length}: ${skipped.join(', ')})` : ''
    return { success: skipped.length === 0, message: `Rolled back ${reverted} Response Page change(s)${skippedNote}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed after ${reverted} of ${data.entries.length}: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
