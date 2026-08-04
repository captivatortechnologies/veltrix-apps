import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import { buildRestoreBody, type IntegrationRollbackData, type IntegrationService } from './_shared'

/**
 * Undo a notification-integrations deploy from rollbackData.previous (written
 * by deploy()):
 *   - an integration we CREATED (existed=false) -> DELETE /api/external_service/config/{service}?template=
 *   - an integration we UPDATED (existed=true)  -> PUT    /api/external_service/config/{service}?template=
 *                                                  with the prior envelope (restore)
 * An entry missing its service or server id is skipped.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as IntegrationRollbackData
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.service || !entry.serverId) {
        skipped++
        continue
      }
      const service = entry.service as IntegrationService
      const path = `/api/external_service/config/${encodeURIComponent(service)}?template=${encodeURIComponent(entry.name)}`
      if (entry.existed && entry.prior) {
        const res = await client.request('PUT', path, buildRestoreBody(service, entry.prior))
        if (res.error) throw new Error(`restore integration "${entry.name}" (${service}) failed: ${res.error}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.request('DELETE', path)
        // An integration already gone (404) is an acceptable rollback outcome.
        if (res.error && res.status !== 404) throw new Error(`delete integration "${entry.name}" (${service}) failed: ${res.error}`)
        deleted++
      } else {
        skipped++
      }
    }
    return {
      success: true,
      message: `Rolled back notification integrations: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
