import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import type { RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  // Log source groups are append-only (the API has no update or delete), so
  // there is nothing to undo — groups created by a deploy cannot be removed.
  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const createdCount = (Array.isArray(data?.entries) ? data.entries : []).filter((e) => !e.existed).length
  const msg =
    createdCount > 0
      ? `Log source groups are append-only; ${createdCount} group(s) created by this deploy cannot be removed via the API`
      : 'No log source groups to roll back (this type is append-only)'
  return { success: true, message: msg }
}
