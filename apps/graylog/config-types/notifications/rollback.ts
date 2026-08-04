import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveNotification, type GraylogNotification } from './_shared'

/**
 * Undo a notifications deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /api/events/notifications/{id} with the prior
 * config (restore), or — when the notification was newly created (prior null)
 * — DELETE /api/events/notifications/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; notificationId: string | null; notification: GraylogNotification | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for notification rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { notificationId, notification } of previous) {
      if (!notificationId) {
        skipped++
        continue
      }
      const path = `${base}/api/events/notifications/${encodeURIComponent(notificationId)}`
      if (notification) {
        await sendJson('PUT', path, headers, bodyFromLiveNotification(notification))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back notifications: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
