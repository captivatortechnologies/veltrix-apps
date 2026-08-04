import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import type { ComplianceFrameworkRollbackData } from './_shared'

/**
 * Undo a custom-compliance-frameworks deploy from rollbackData.previous
 * (written by deploy()):
 *   - a framework we CREATED (existed=false) -> DELETE /api/compliance/frameworks/{id}
 *   - a framework we UPDATED (existed=true)  -> PUT    /api/compliance/frameworks/{id}
 *                                               with the recorded body (restore)
 * The "recorded body" is this app's own last-declared body, not a live read —
 * see _shared.ts for why (Orca never echoes sections back). An entry with no
 * id (a create whose id we never learned) is skipped.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as ComplianceFrameworkRollbackData
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
      if (!entry.serverId) {
        skipped++
        continue
      }
      const path = `/api/compliance/frameworks/${encodeURIComponent(entry.serverId)}`
      if (entry.existed && entry.prior) {
        const res = await client.request('PUT', path, entry.prior)
        if (res.error) throw new Error(`restore compliance framework "${entry.name}" failed: ${res.error}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.request('DELETE', path)
        // A framework already gone (404) is an acceptable rollback outcome.
        if (res.error && res.status !== 404) throw new Error(`delete compliance framework "${entry.name}" failed: ${res.error}`)
        deleted++
      } else {
        skipped++
      }
    }
    return {
      success: true,
      message: `Rolled back custom compliance frameworks: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
