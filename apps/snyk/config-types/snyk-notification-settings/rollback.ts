import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { NotificationRollbackData } from './deploy'

/**
 * Roll back notification settings by re-applying (PUT) the whole object captured
 * before deploy. Because deploy read-merge-PUTs, the captured `prior` is the
 * complete pre-deploy object, so restoring it returns every notification type to
 * its previous state. If nothing was captured, there is nothing to restore.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back notification settings.' }
  }

  const prior = (ctx.rollbackData as NotificationRollbackData | undefined)?.prior
  if (!prior || typeof prior !== 'object' || Object.keys(prior).length === 0) {
    return { success: false, message: 'No previous notification settings captured for rollback' }
  }

  const res = await client.v1('PUT', `${client.v1OrgPath()}/notification-settings`, { body: prior })
  if (!res.ok) {
    return { success: false, message: `Failed to restore notification settings: ${snykErrorMessage(res)}` }
  }

  return { success: true, message: 'Restored Snyk notification settings to their previous values' }
}
