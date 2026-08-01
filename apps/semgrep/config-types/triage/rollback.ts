import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, semgrepErrorMessage } from '../../lib/semgrepApi'
import type { TriageRollbackEntry } from './deploy'

/**
 * Undo a triage deploy from rollbackData.previous (written by deploy()).
 *
 * FLAGGED — best-effort. For each rule, re-triage the EXACT finding ids this
 * deploy changed back to `reopened` (a POST /triage with issue_ids). This cannot
 * restore a finding's prior per-finding triage reason/note, and it does nothing
 * for findings a later scan has since changed — it only reverses THIS deploy's
 * state transition on the ids it recorded.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: TriageRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for triage rollback' }
  }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasSlug) {
    return { success: false, message: 'No Semgrep deployment slug set — configure the "Deployment Slug" app setting.' }
  }

  const reopened: string[] = []

  try {
    for (const entry of previous) {
      if (entry.triagedIssueIds.length === 0) continue
      const res = await client.bulkTriage({
        issue_type: entry.issueType,
        issue_ids: entry.triagedIssueIds,
        new_triage_state: 'reopened',
      })
      if (!res.ok) {
        return { success: false, message: `Rollback failed for rule "${entry.ruleName}": ${semgrepErrorMessage(res)}` }
      }
      reopened.push(`${entry.ruleName} (${entry.triagedIssueIds.length})`)
    }

    return {
      success: true,
      message: `Re-opened findings for ${reopened.length} triage rule(s): ${reopened.join(', ') || '(none)'}`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
