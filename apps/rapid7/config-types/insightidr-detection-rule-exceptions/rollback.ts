import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightIDRClient, insightIDRErrorMessage } from '../../lib/insightidr'
import type { ExceptionRollbackEntry } from './deploy'

/**
 * Roll back detection rule exceptions using the state captured during deploy.
 * Because deploy is CREATE/skip only, rollback deletes the exceptions we created
 * (POST /rules/{rrn}/rule-exceptions/{exception_rrn}/delete); exceptions that
 * already existed were skipped and are left in place.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightIDRClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ExceptionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const created = previousState.filter((e) => !e.existed && e.exceptionRrn)
  if (created.length === 0) {
    return { success: true, message: 'Nothing to roll back — no exceptions were created by this deployment' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...created].reverse()) {
      const res = await client.request(
        'POST',
        `/idr/v1/rules/${encodeURIComponent(entry.ruleRrn)}/rule-exceptions/${encodeURIComponent(entry.exceptionRrn as string)}/delete`,
        { body: { note: 'Rolled back by Veltrix Security-as-Code' } },
      )
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete exception "${entry.label}": ${insightIDRErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} detection rule exception(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${created.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
