import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { hasSplunkAddress, buildSplunkUrl, buildAuthHeader, postForm, splunkRequest, toFormBody } from '../../lib/splunkApi'
import { AUTH_TOKENS_PATH } from './deploy'

interface RollbackEntry {
  username: string
  id: string
  created: boolean
  previousStatus?: string
}

/**
 * Rollback API access token configuration:
 *  - restores the previous enabled/disabled status of tokens this deploy
 *    only reconciled (found pre-existing, no immutable field changed)
 *  - deletes tokens this deploy created (including a token created to
 *    replace one whose immutable fields drifted — the original is gone
 *    either way; Splunk never lets it be restored with its old value)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, rollbackData } = ctx

  if (!credential || !hasSplunkAddress(component, connectivity, connectivityProvider)) {
    return { success: false, message: 'Missing credential or Splunk management address for rollback' }
  }

  const entries = ((rollbackData as { entries?: RollbackEntry[] } | null)?.entries ?? []).filter((e) => e.id)
  if (entries.length === 0) {
    return { success: false, message: 'No previous state available for API access token rollback' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider, ctx.settings)
  const auth = buildAuthHeader(credential)
  const undeletable: string[] = []
  let restored = 0
  let deleted = 0

  try {
    for (const entry of entries) {
      if (entry.created) {
        try {
          await splunkRequest(`${baseUrl}${AUTH_TOKENS_PATH}/${encodeURIComponent(entry.username)}`, {
            method: 'DELETE',
            headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: toFormBody({ id: entry.id }),
          })
          deleted++
        } catch {
          undeletable.push(`${entry.username} (${entry.id})`)
        }
      } else if (entry.previousStatus) {
        await postForm(baseUrl, auth, `${AUTH_TOKENS_PATH}/${encodeURIComponent(entry.username)}`, {
          id: entry.id,
          status: entry.previousStatus,
        })
        restored++
      }
    }

    const actions: string[] = []
    if (restored > 0) actions.push(`restored ${restored} token status(es)`)
    if (deleted > 0) actions.push(`deleted ${deleted} created token(s)`)
    if (undeletable.length > 0) {
      actions.push(`could NOT delete ${undeletable.length} token(s) (${undeletable.join(', ')}) — remove manually if unwanted`)
    }
    return { success: undeletable.length === 0, message: `Rollback ${undeletable.length ? 'incomplete' : 'complete'}: ${actions.join('; ') || 'no changes needed'}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
