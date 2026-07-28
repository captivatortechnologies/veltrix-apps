import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { APP_CONFIG_PATH, buildRestoreBody } from './appConfig'
import { assignPolicy, targetApps, type AppConfigRollbackEntry } from './deploy'

/**
 * Roll back app configuration policies using the state captured during deploy:
 * policies this deploy created are deleted; policies it updated are restored to
 * their prior custom settings, prior targeted apps and prior assignment groups.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AppConfigRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${APP_CONFIG_PATH}/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete app configuration policy "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PATCH', `${APP_CONFIG_PATH}/${entry.id}`, {
          body: buildRestoreBody(entry.name, entry.prior.description, entry.prior.customSettings),
        })
        if (!res.ok) throw new Error(`Failed to restore app configuration policy "${entry.name}": ${graphErrorMessage(res)}`)

        const restored = {
          sectionName: entry.name,
          name: entry.name,
          description: entry.prior.description,
          platform: entry.prior.platform,
          appGroupType: entry.prior.appGroupType,
          targetedApps: entry.prior.targetedApps,
          customSettings: entry.prior.customSettings,
          assignment: {
            includeGroupIds: entry.prior.assignment.includeGroupIds,
            excludeGroupIds: entry.prior.assignment.excludeGroupIds,
            allDevices: false,
            allUsers: entry.prior.assignment.allUsers,
          },
        }
        await targetApps(client, entry.id, restored)
        await assignPolicy(client, entry.id, restored.assignment, entry.name)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} app configuration policy(ies): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
