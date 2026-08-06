import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { configureNotificationsSettings, getNotificationsSettings, type GzConfigureNotificationsBody } from '../../lib/gravityZoneApi'
import {
  buildNotificationSettingsBody,
  declaredLiveSnapshot,
  extractNotificationSettingsSpecs,
  notificationSettingsMatch,
  parseNotificationsSettings,
} from './_shared'

export interface NotificationSettingsRollbackEntry {
  accountId: string
  changed: boolean
  prior?: GzConfigureNotificationsBody
}

/**
 * Deploy GravityZone notification settings declaration(s), reconciled by
 * accountId (blank = the account that generated the API key). An account
 * always exists — there is no create/delete, only
 * accounts.configureNotificationsSettings — and only fields the canvas
 * declares are sent; an undeclared field means "leave this field alone".
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractNotificationSettingsSpecs(ctx.canvas)
  const previous: NotificationSettingsRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = spec.accountId || '(own account)'
      const live = await getNotificationsSettings(client, spec.accountId || undefined)
      const { value: notificationsSettings } = parseNotificationsSettings(spec)

      if (notificationSettingsMatch(spec, notificationsSettings, live)) {
        previous.push({ accountId: spec.accountId, changed: false })
      } else {
        previous.push({ accountId: spec.accountId, changed: true, prior: declaredLiveSnapshot(spec, live) })
        const body = buildNotificationSettingsBody(spec, notificationsSettings)
        await configureNotificationsSettings(client, body)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} notification settings declaration(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Notification settings deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previous },
    }
  }
}
