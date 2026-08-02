import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDarktraceUrl, darktraceAuthFrom, dtPostJson } from '../../lib/darktraceApi'

/**
 * Undo an intel-feed deploy from rollbackData.created (written by deploy()): for
 * each entry THIS deploy added, POST /intelfeed { removeentry } to take it back
 * off the watched list. Entries that were already present before the deploy were
 * never claimed, so they are left in place. Applied over the Darktrace REST API
 * (443, DSA-signed). Verify /intelfeed removeentry against a live Darktrace.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { created?: Array<{ entry: string; source: string }> }
  const created = data.created ?? []
  if (created.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const auth = darktraceAuthFrom(credential)
  if (!auth) {
    return { success: false, message: 'Missing Darktrace API token pair (public + private) for intel-feed rollback' }
  }

  const base = buildDarktraceUrl(component, connectivity, connectivityProvider)

  let removed = 0
  try {
    for (const { entry, source } of created) {
      if (!entry) continue
      const body: Record<string, unknown> = { removeentry: entry }
      if (source) body.source = source
      await dtPostJson(base, '/intelfeed', body, auth)
      removed++
    }
    return { success: true, message: `Rolled back intel feed: removed ${removed} watched entr${removed === 1 ? 'y' : 'ies'}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed after removing ${removed} entr${removed === 1 ? 'y' : 'ies'}: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
