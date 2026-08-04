import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveLookupTable, type GraylogLookupTable } from './_shared'

/**
 * Undo a lookup-tables deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /api/system/lookup/tables/{name} with the prior config
 * (restore), or — when the table was newly created (prior null) — DELETE
 * /api/system/lookup/tables/{id} to remove it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; tableId: string | null; table: GraylogLookupTable | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for lookup-table rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { name, tableId, table } of previous) {
      if (table) {
        await sendJson('PUT', `${base}/api/system/lookup/tables/${encodeURIComponent(name)}`, headers, bodyFromLiveLookupTable(table))
        restored++
      } else if (tableId) {
        await sendJson('DELETE', `${base}/api/system/lookup/tables/${encodeURIComponent(tableId)}`, headers)
        deleted++
      } else {
        skipped++
      }
    }
    return {
      success: true,
      message: `Rolled back lookup tables: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
