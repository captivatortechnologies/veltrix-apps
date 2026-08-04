import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveSidecarCollector, type GraylogSidecarCollector } from './_shared'

/**
 * Undo a sidecar-collectors deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /api/sidecar/collectors/{id} with the prior
 * definition (restore), or — when the collector was newly created (prior
 * null) — DELETE /api/sidecar/collectors/{id} to remove it. Graylog refuses to
 * delete a collector still referenced by a configuration, which surfaces as a
 * clear rollback error rather than being silently skipped.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; os: string; collectorId: string | null; collector: GraylogSidecarCollector | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for sidecar-collector rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { collectorId, collector } of previous) {
      if (!collectorId) {
        skipped++
        continue
      }
      const path = `${base}/api/sidecar/collectors/${encodeURIComponent(collectorId)}`
      if (collector) {
        await sendJson('PUT', path, headers, bodyFromLiveSidecarCollector(collector))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back sidecar collectors: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
