import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { reportTemplatePath, reportTemplateWriteError, type ReportTemplateRollbackEntry } from './deploy'

/**
 * Roll back report templates using the state captured during deploy:
 *   - templates that were CREATED are deleted (action=delete, form-encoded —
 *     unlike create/update, delete does not take an XML body)
 *   - templates that were UPDATED cannot be restored: the only pre-deploy
 *     state this app reads is (id, title) from the shared metadata list —
 *     Export never returns a template's id, and this app does not persist the
 *     settings XML that was live before the deploy (only what was DECLARED).
 *     An updated template's prior settings are not recoverable, so this is a
 *     documented limitation rather than a silent no-op — it is reported.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ReportTemplateRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const deleted: string[] = []
  const notRestorable: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const path = reportTemplatePath(entry.templateType)
          const res = await client.post(path, { action: 'delete', template_id: entry.id })
          const failed = reportTemplateWriteError(res)
          // A 404 / already-deleted template is not a rollback failure.
          if (failed && res.status !== 404) {
            throw new Error(`Failed to delete ${entry.label} report template: ${failed}`)
          }
          deleted.push(entry.label)
        }
        continue
      }
      // Updated — no prior settings XML is available to restore.
      notRestorable.push(entry.label)
    }

    const parts: string[] = []
    if (deleted.length > 0) parts.push(`deleted ${deleted.length} created report template(s): ${deleted.join(', ')}`)
    if (notRestorable.length > 0) {
      parts.push(
        `${notRestorable.length} updated report template(s) could NOT be restored (this app does not retain prior settings XML) and keep their newly deployed settings: ${notRestorable.join(', ')}`,
      )
    }
    return { success: true, message: parts.length > 0 ? parts.join('; ') : 'Nothing to roll back' }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after deleting ${deleted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
