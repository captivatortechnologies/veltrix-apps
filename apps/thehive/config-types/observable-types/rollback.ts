import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, PRIMARY } from '../../lib/thehiveApi'

/**
 * Undo an observable-types deploy from rollbackData.previous (written by
 * deploy()). deploy only records the types it CREATED, so rollback simply
 * DELETEs each one — pre-existing types are never recorded and thus never
 * touched. There is no restore path (TheHive has no update endpoint for
 * observable types). Verify paths against a live TheHive (see README).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; typeId: string | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for observable type rollback' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let deleted = 0
  let skipped = 0
  try {
    for (const { typeId } of previous) {
      if (!typeId) {
        // A created type whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      await sendJson('DELETE', `${base}${PRIMARY.observableTypeById(typeId)}`, headers)
      deleted++
    }
    return {
      success: true,
      message: `Rolled back observable types: ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
