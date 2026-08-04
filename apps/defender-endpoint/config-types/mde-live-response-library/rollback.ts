// =============================================================================
// Roll back a Live Response library deploy via the Defender API.
//
// Undo runs in reverse order. A file this deploy CREATED (existed: false) is
// cleanly reversible: DELETE /api/libraryfiles/{fileName} (a 404 is tolerated —
// already gone). A file this deploy OVERWROTE (existed: true) is NOT reversible:
// Defender's Live Response library API has no "download content" endpoint, so
// the bytes that were live before this deploy were never captured and cannot be
// restored. Those files are left exactly as this deploy left them, and are
// called out by name in the result message rather than silently reported as
// fully rolled back — an honest, documented API limitation (see validate.ts),
// not a bug in this handler.
// =============================================================================

import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient, mdeErrorMessage } from '../../lib/mde'
import type { LibraryFileRollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: LibraryFileRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const deleted: string[] = []
  const notRestorable: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        const res = await client.request('DELETE', `/libraryfiles/${encodeURIComponent(entry.fileName)}`)
        if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete library file "${entry.fileName}": ${mdeErrorMessage(res)}`)
        deleted.push(entry.fileName)
      } else {
        // No download-content API exists to recover what was there before —
        // deliberately left as this deploy wrote it. See the module comment.
        notRestorable.push(entry.fileName)
      }
    }
    const caveat =
      notRestorable.length > 0
        ? ` (${notRestorable.length} pre-existing file(s) could not have their original content restored — no such API exists — and were left as deployed: ${notRestorable.join(', ')})`
        : ''
    return { success: true, message: `Rolled back ${deleted.length} created library file(s)${caveat}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${deleted.length} of ${previousState.filter((e) => !e.existed).length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
