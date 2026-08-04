import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson, sendJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { buildNotificationEntity, notificationsFromList, findNotification, type GraylogNotification } from './_shared'

/**
 * Deploy Graylog event notifications over the REST API:
 *   read (rollback): GET  /api/events/notifications        → find the live notification by title
 *   create:          POST /api/events/notifications         → { entity: {...} } → NotificationDto { id, ... }
 *   update:          PUT  /api/events/notifications/{id}    → NotificationDto (id in body must match URL)
 *
 * The notification TITLE is the stable identity used to upsert. rollbackData
 * records, per notification, the prior notification (null when it did not
 * exist) AND its id — so rollback can restore the prior config or delete the
 * one we created.
 */
async function listNotifications(base: string, headers: Record<string, string>): Promise<GraylogNotification[]> {
  try {
    return notificationsFromList(await getJson<unknown>(`${base}/api/events/notifications`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for notification deployment' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ title: string; notificationId: string | null; notification: GraylogNotification | null }> = []
  const applied: string[] = []

  try {
    const live = await listNotifications(base, headers)

    for (const item of items) {
      const title = asString(item.fields.title)
      if (!title) continue

      const { entity, error } = buildNotificationEntity(item.fields)
      if (error || !entity) throw new Error(`Notification "${title}": ${error ?? 'could not build request body'}`)

      const existing = findNotification(live, title)
      if (existing && existing.id) {
        await sendJson('PUT', `${base}/api/events/notifications/${encodeURIComponent(existing.id)}`, headers, { id: existing.id, ...entity })
        previous.push({ title, notificationId: existing.id, notification: existing })
      } else {
        const created = await sendJson<GraylogNotification>('POST', `${base}/api/events/notifications`, headers, { entity, share_request: null })
        previous.push({ title, notificationId: created?.id ?? null, notification: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} notification(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Notification deploy failed after ${applied.length} notification(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
