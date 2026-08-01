import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'

/**
 * Rollback for hash exceptions is INHERENTLY LIMITED: the Cortex XDR public API
 * documents only ADD endpoints for the allow / block lists — there is no public
 * endpoint to remove a hash exception. So this handler cannot programmatically
 * undo a deploy. It reports, honestly, how many hashes were added (from
 * rollbackData.added, written by deploy) and asks the operator to remove them in
 * the Cortex XDR console. It returns success so the pipeline is not blocked by a
 * limitation of the vendor API.
 *
 * VERIFY against live Cortex XDR — if a remove endpoint is ever exposed, wire it
 * here and delete the added hashes.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { added?: Array<{ hash: string; listType: string }> }
  const added = data.added ?? []
  if (added.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const summary = added.map((a) => `${a.listType}:${a.hash}`).join(', ')
  return {
    success: true,
    message:
      `Cannot auto-remove ${added.length} hash exception(s) — the Cortex XDR public API is add-only for ` +
      `hash exceptions (no remove endpoint). Remove them manually in the console: ${summary}`,
  }
}
