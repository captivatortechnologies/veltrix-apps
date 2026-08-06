import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { deleteIntegration, updateIntegration, type GzIntegration } from '../../lib/gravityZoneApi'
import { findLiveIntegration, listAllIntegrations, liveIntegrationId } from './_shared'
import type { IntegrationRollbackEntry } from './deploy'

/**
 * Roll back integrations using the state captured during deploy:
 *   - integrations this deploy CREATED are deleted (integrations.deleteIntegration)
 *   - integrations this deploy UPDATED are restored to their prior name/specifics
 *   - unchanged integrations are left alone
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: IntegrationRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    let live: GzIntegration[] | null = null
    for (const entry of [...previous].reverse()) {
      if (entry.action === 'created') {
        if (!live) live = await listAllIntegrations(client)
        const match = findLiveIntegration(live, entry.name)
        if (match) await deleteIntegration(client, liveIntegrationId(match))
      } else if (entry.action === 'updated' && entry.prior) {
        if (!live) live = await listAllIntegrations(client)
        const match = findLiveIntegration(live, entry.name)
        if (match) await updateIntegration(client, { integrationId: liveIntegrationId(match), name: entry.prior.name, specifics: entry.prior.specifics ?? {} })
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} integration(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
