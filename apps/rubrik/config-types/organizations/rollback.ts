import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { rubrikConnect, sendJson, MISSING_CREDENTIAL_MESSAGE, resolveServiceAccount } from '../../lib/rubrikApi'

interface RollbackEntry {
  name: string
  existed: boolean
  id: string | null
}

/**
 * Undo an Organizations deploy from rollbackData.previous (written by deploy()):
 *   - an organization we CREATED (existed=false): DELETE /api/internal/organization/{id}
 *   - an organization that already existed (existed=true): left untouched — this
 *     deploy never modified it, so there is nothing to restore.
 * An entry whose id we never learned is skipped (nothing safe to undo). Applied
 * over the Rubrik CDM internal REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!resolveServiceAccount(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch (error) {
    return { success: false, message: `Rubrik connection failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }

  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (entry.existed || !entry.id) {
        skipped++
        continue
      }
      await sendJson(conn, 'DELETE', `/api/internal/organization/${encodeURIComponent(entry.id)}`)
      deleted++
    }
    return {
      success: true,
      message: `Rolled back organizations: ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
