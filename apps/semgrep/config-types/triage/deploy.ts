import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, semgrepErrorMessage, triagedCount, triagedIssueIds } from '../../lib/semgrepApi'
import { buildTriageBody, extractTriageSpecs } from './_shared'

/** The findings one triage rule changed, captured for a best-effort rollback. */
export interface TriageRollbackEntry {
  ruleName: string
  issueType: string
  /** The exact finding ids this deploy triaged (from the API response). */
  triagedIssueIds: number[]
}

/**
 * Deploy Semgrep triage rules over the public REST API v1.
 *
 * FLAGGED — this is an IMPERATIVE bulk action, not a declarative reconcile.
 * Semgrep has no triage-rule object; each rule is applied with a single
 * POST /deployments/{slug}/triage against the findings that match its selection
 * RIGHT NOW. The finding ids the API reports as triaged are recorded in
 * rollbackData so rollback can re-open exactly those findings; nothing else about
 * a finding's prior triage is recoverable.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { credential, settings, canvas } = ctx

  if (!credential) {
    return { success: false, message: 'Missing credential for Semgrep triage deployment' }
  }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasSlug) {
    return { success: false, message: 'No Semgrep deployment slug set — configure the "Deployment Slug" app setting.' }
  }

  const specs = extractTriageSpecs(canvas).filter((s) => s.ruleName)
  const previous: TriageRollbackEntry[] = []
  const applied: string[] = []
  let totalTriaged = 0

  try {
    for (const spec of specs) {
      const res = await client.bulkTriage(buildTriageBody(spec))
      if (!res.ok) {
        return {
          success: false,
          message: `Triage deploy failed for rule "${spec.ruleName}": ${semgrepErrorMessage(res)}`,
          artifacts: { applied, totalTriaged },
          rollbackData: { previous },
        }
      }

      const ids = triagedIssueIds(res)
      const count = triagedCount(res) || ids.length
      previous.push({ ruleName: spec.ruleName, issueType: spec.issueType, triagedIssueIds: ids })
      applied.push(`${spec.ruleName} (${count})`)
      totalTriaged += count
    }

    if (applied.length === 0) {
      return { success: true, message: 'No triage rules to apply.', artifacts: { applied: [], totalTriaged: 0 }, rollbackData: { previous: [] } }
    }

    return {
      success: true,
      message: `Applied ${applied.length} triage rule(s), ${totalTriaged} finding(s) triaged: ${applied.join(', ')}`,
      artifacts: { applied, totalTriaged },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Triage deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, totalTriaged },
      rollbackData: { previous },
    }
  }
}
