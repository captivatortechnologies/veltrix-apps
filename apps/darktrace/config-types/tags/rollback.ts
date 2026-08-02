import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDarktraceUrl, darktraceAuthFrom, dtDelete } from '../../lib/darktraceApi'

/**
 * Undo a tags deploy from rollbackData.created (written by deploy()): for each tag
 * THIS deploy created, DELETE /tags/{tid} to remove it. Tags that already existed
 * before the deploy were never claimed, so they are left in place. A created tag
 * whose numeric `tid` was never resolved is reported but left alone rather than
 * risking a delete by the wrong id. Applied over the Darktrace REST API (443,
 * DSA-signed). Verify /tags/{tid} DELETE against a live Darktrace.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { created?: Array<{ name: string; tid: number | null }> }
  const created = data.created ?? []
  if (created.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const auth = darktraceAuthFrom(credential)
  if (!auth) {
    return { success: false, message: 'Missing Darktrace API token pair (public + private) for tags rollback' }
  }

  const base = buildDarktraceUrl(component, connectivity, connectivityProvider)

  let removed = 0
  const unresolved: string[] = []
  try {
    for (const { name, tid } of created) {
      if (tid === null || tid === undefined) {
        unresolved.push(name) // never learned the tid — do not guess a delete target
        continue
      }
      await dtDelete(base, `/tags/${encodeURIComponent(String(tid))}`, auth)
      removed++
    }
    const summary = `Rolled back tags: deleted ${removed} tag${removed === 1 ? '' : 's'}.`
    return {
      success: true,
      message: unresolved.length
        ? `${summary} ${unresolved.length} could not be resolved to a tag id and were left in place: ${unresolved.join(', ')}.`
        : summary,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed after deleting ${removed} tag${removed === 1 ? '' : 's'}: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
