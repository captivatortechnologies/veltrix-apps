import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'

/**
 * Undo a taxonomies deploy from rollbackData.previous (written by deploy()): for
 * each entry, re-apply the prior enabled state — POST /taxonomies/enable/<id> when
 * it was enabled before, POST /taxonomies/disable/<id> when it was disabled.
 * Applied over the MISP REST API (443). Verify /taxonomies/enable|disable/<id>
 * against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ namespace: string; taxonomyId: number | string; enabledBefore: boolean }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for taxonomy rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  try {
    for (const { taxonomyId, enabledBefore } of previous) {
      const verb = enabledBefore ? 'enable' : 'disable'
      await sendJson('POST', `${base}/taxonomies/${verb}/${encodeURIComponent(String(taxonomyId))}`, headers, {})
      restored++
    }
    return { success: true, message: `Rolled back taxonomies: ${restored} restored.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
