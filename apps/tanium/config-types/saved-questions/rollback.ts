import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession } from '../../lib/taniumApi'
import { rollbackEntity, type UpsertRecord } from '../../lib/taniumRestEntity'
import { SAVED_QUESTIONS_RESOURCE, restoreSavedQuestionBody, type TaniumSavedQuestion } from './_shared'

/**
 * Undo a saved-questions deploy from rollbackData.previous (written by deploy()):
 *   - a question that existed before → delete the replacement, recreate the prior.
 *   - a question this deploy created → delete it.
 *   - an entry whose id we never learned → looked up by name, else left in place.
 * Applied over the Tanium REST v2 API (443) via delete + recreate.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<UpsertRecord<TaniumSavedQuestion>> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for saved-question rollback' }
  }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)
  let restored = 0
  let deleted = 0
  let left = 0
  try {
    const session = await resolveTaniumSession(base, credential)
    for (const record of previous) {
      const outcome = await rollbackEntity(base, session, SAVED_QUESTIONS_RESOURCE, record, restoreSavedQuestionBody)
      if (outcome === 'restored') restored++
      else if (outcome === 'deleted') deleted++
      else left++
    }
    const parts = [`${restored} restored`, `${deleted} deleted`]
    if (left) parts.push(`${left} left in place`)
    return { success: true, message: `Rolled back saved questions: ${parts.join(', ')}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
