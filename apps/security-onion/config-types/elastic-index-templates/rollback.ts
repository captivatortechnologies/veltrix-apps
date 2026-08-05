import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildEsUrl, buildAuthHeader, sendJson } from '../../lib/soConsole'

/**
 * Undo an index-template deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT the prior template body back (it is already
 * in PUT-compatible shape — the same `index_patterns`/`template`/`composed_of`/
 * `priority` fields GET returns), or DELETE the template we created (its prior
 * body was null). Applied over the Elasticsearch REST API (9200).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ templateName: string; template: Record<string, unknown> | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for index template rollback' }
  }

  const esUrl = buildEsUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { templateName, template } of previous) {
      const path = `${esUrl}/_index_template/${encodeURIComponent(templateName)}`
      if (template) {
        await sendJson('PUT', path, auth, template)
        restored++
      } else {
        await sendJson('DELETE', path, auth)
        deleted++
      }
    }
    return { success: true, message: `Rolled back index templates: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
