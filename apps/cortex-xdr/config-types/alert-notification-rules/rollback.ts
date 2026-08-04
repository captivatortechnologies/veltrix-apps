import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCortexClient, cortexWriteError } from '../../lib/cortexXdrApi'
import { NOTIFICATION_RULE_ENDPOINTS, type LiveNotificationRule } from './_shared'

/**
 * Undo an alert-notification-rule deploy from rollbackData.previous (written by
 * deploy()): rules that existed before are RESTORED via PUT .../rule/{rule_uuid}
 * with their prior live snapshot (including their prior enabled/disabled state,
 * restored via the status endpoint); rules this deploy CREATED (prior null) are
 * DELETED via DELETE .../rule/{rule_uuid} when the created uuid was captured.
 *
 * VERIFY every endpoint path + the auth requirement against a live Cortex XDR
 * tenant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; prior: LiveNotificationRule | null; createdUuid?: string }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for alert-notification-rule rollback' }
  }

  const built = buildCortexClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const restores = previous.filter((p) => p.prior)
  const deletable = previous.filter((p) => !p.prior && p.createdUuid)
  const unrecoverable = previous.filter((p) => !p.prior && !p.createdUuid)

  try {
    for (const { prior } of restores) {
      const p = prior as LiveNotificationRule
      const body = {
        name: p.name,
        description: p.description,
        forward_type: p.forward_type,
        filter: p.filter,
        forward_source: p.forward_source,
        applications: p.applications,
        time_zone: p.time_zone,
        mail_format: p.mail_format,
        syslog_format: p.syslog_format,
        slack_format: p.slack_format,
      }
      const res = await client.request('PUT', NOTIFICATION_RULE_ENDPOINTS.ruleById(p.rule_uuid as string), body)
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback restore failed: ${error}` }

      const statusRes = await client.request('PATCH', NOTIFICATION_RULE_ENDPOINTS.statusById(p.rule_uuid as string), {
        status: p.enabled === false ? 'disabled' : 'enabled',
      })
      const statusError = cortexWriteError(statusRes)
      if (statusError) return { success: false, message: `Rollback restore succeeded but failed to restore enabled state: ${statusError}` }
    }
    for (const { createdUuid } of deletable) {
      const res = await client.request('DELETE', NOTIFICATION_RULE_ENDPOINTS.ruleById(createdUuid as string))
      const error = cortexWriteError(res)
      if (error) return { success: false, message: `Rollback delete failed: ${error}` }
    }
    return {
      success: true,
      message:
        `Rolled back alert notification rules: ${restores.length} restored, ${deletable.length} deleted.` +
        (unrecoverable.length > 0
          ? ` ${unrecoverable.length} newly-created rule(s) could not be auto-deleted (create response did not include a rule_uuid) — remove them manually via Settings > Configurations > Alert Notification Rules.`
          : ''),
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
