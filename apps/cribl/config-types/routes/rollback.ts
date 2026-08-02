import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, sendJson, groupResourcePath } from '../../lib/criblApi'
import type { CriblRoutingTable } from './_shared'

/**
 * Undo a routes deploy from rollbackData.previous: restore the prior routing
 * table (PATCH /routes/<id>), or — when the table was newly created (prior null)
 * — remove it (DELETE /routes/<id>). Because Cribl ships one table per group,
 * the prior table is almost always present, so rollback is a restore. Verify
 * against a live Cribl.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ id: string; group: string; table: CriblRoutingTable | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for routes rollback' }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  let restored = 0
  let removed = 0
  try {
    const headers = await criblConnect(base, credential)

    for (const { id, group, table } of previous) {
      if (!id) continue
      const url = `${groupResourcePath(base, group, 'routes')}/${encodeURIComponent(id)}`
      if (table) {
        await sendJson('PATCH', url, headers, table)
        restored++
      } else {
        await sendJson('DELETE', url, headers)
        removed++
      }
    }
    return { success: true, message: `Rolled back routing tables: ${restored} restored, ${removed} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
