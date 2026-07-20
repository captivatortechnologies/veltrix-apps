import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type RateLimitRollbackData } from './deploy'

/**
 * Roll back the org rate-limit settings by replaying the prior state captured
 * during deploy (a full replace via PUT for each part). There is nothing to
 * create or delete — the singletons always exist. Warning-threshold is only
 * restored when a prior value was captured (it is optional).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const prior = ctx.rollbackData as RateLimitRollbackData | undefined
  if (!prior || (!prior.priorAdminNotifications && !prior.priorPerClient && !prior.priorWarningThreshold)) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const restored: string[] = []

  try {
    if (prior.priorAdminNotifications) {
      const res = await client.request('PUT', '/rate-limit-settings/admin-notifications', {
        body: prior.priorAdminNotifications,
      })
      if (!res.ok) throw new Error(`Failed to restore admin-notification settings: ${oktaErrorMessage(res)}`)
      restored.push('admin-notifications')
    }

    if (prior.priorPerClient) {
      const res = await client.request('PUT', '/rate-limit-settings/per-client', {
        body: prior.priorPerClient,
      })
      if (!res.ok) throw new Error(`Failed to restore per-client rate-limit settings: ${oktaErrorMessage(res)}`)
      restored.push('per-client')
    }

    if (prior.priorWarningThreshold) {
      const res = await client.request('PUT', '/rate-limit-settings/warning-threshold', {
        body: prior.priorWarningThreshold,
      })
      if (!res.ok) throw new Error(`Failed to restore warning-threshold setting: ${oktaErrorMessage(res)}`)
      restored.push('warning-threshold')
    }

    return {
      success: true,
      message: `Restored rate-limit settings: ${restored.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after restoring ${restored.length} part(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
