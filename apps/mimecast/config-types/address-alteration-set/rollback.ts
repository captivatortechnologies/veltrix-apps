import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import type { RollbackEntry } from './deploy'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  // Address alteration sets have no delete API, so a set this app created cannot
  // be removed programmatically — rollback is a no-op that only reports what was
  // left in place for an operator to clean up in the Administration Console.
  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const created = entries.filter((e) => !e.existed && e.id)

  if (created.length === 0) {
    return { success: true, message: 'Nothing to roll back — no app-created address alteration sets' }
  }
  return {
    success: true,
    message: `Left ${created.length} app-created address alteration set(s) in place — Mimecast has no delete-set API; remove them in the Administration Console if required`,
  }
}
