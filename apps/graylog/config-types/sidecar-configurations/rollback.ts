import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveSidecarConfig, type GraylogSidecarConfig } from './_shared'

/**
 * Undo a sidecar-configurations deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /api/sidecar/configurations/{id} with the
 * prior template/tags (restore), or — when the configuration was newly
 * created (prior null) — DELETE /api/sidecar/configurations/{id} to remove it.
 * Graylog refuses to delete (or change the collector of) a configuration still
 * assigned to a Sidecar, which surfaces as a clear rollback error rather than
 * being silently skipped.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; configId: string | null; config: GraylogSidecarConfig | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for sidecar-configuration rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { configId, config } of previous) {
      if (!configId) {
        skipped++
        continue
      }
      const path = `${base}/api/sidecar/configurations/${encodeURIComponent(configId)}`
      if (config) {
        await sendJson('PUT', path, headers, bodyFromLiveSidecarConfig(config))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back sidecar configurations: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
