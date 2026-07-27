import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import type { RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  // Offense closing reasons are append-only (the API has no update or delete), so
  // there is nothing to undo — reasons created by a deploy cannot be removed.
  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const created = (Array.isArray(data?.entries) ? data.entries : []).filter((e) => !e.existed).length
  const msg =
    created > 0
      ? `Closing reasons are append-only; ${created} reason(s) created by this deploy cannot be removed via the API`
      : 'No closing reasons to roll back (this type is append-only)'
  return { success: true, message: msg }
}
