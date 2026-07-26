import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import type { FullReport } from './validate'
import type { ReportRollbackEntry } from './deploy'

const DELETE_REPORT_MUTATION = `
mutation DeleteReport($input: DeleteReportInput!) {
  deleteReport(input: $input) {
    _stub
  }
}`

const UPDATE_REPORT_MUTATION = `
mutation UpdateReport($input: UpdateReportInput!) {
  updateReport(input: $input) {
    report { id }
  }
}`

/**
 * Roll back reports using the state captured during deploy:
 *   - reports that were created are deleted (deleteReport)
 *   - reports that were updated are restored to their captured prior state via an
 *     update override (updateReport)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ReportRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(DELETE_REPORT_MUTATION, { input: { id: entry.id } })
          if (res.transportError) throw new Error(`Failed to delete report "${entry.label}": ${res.transportError}`)
          if (res.errors) throw new Error(`Failed to delete report "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql(UPDATE_REPORT_MUTATION, {
          input: { id: entry.id, override: priorToOverride(entry.prior) },
        })
        if (res.transportError) throw new Error(`Failed to restore report "${entry.label}": ${res.transportError}`)
        if (res.errors) throw new Error(`Failed to restore report "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Wiz report(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update override from a captured prior report state. */
function priorToOverride(prior: FullReport): Record<string, unknown> {
  const override: Record<string, unknown> = {
    name: prior.name ?? '',
    graphQueryParams: { query: prior.params?.query },
  }
  if (typeof prior.runIntervalHours === 'number') {
    override.runIntervalHours = prior.runIntervalHours
    if (prior.runStartsAt) override.runStartsAt = prior.runStartsAt
  }
  return override
}
