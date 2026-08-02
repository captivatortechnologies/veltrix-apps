import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildDatadogClient, datadogErrorMessage } from '../../lib/datadogApi'
import { ruleToBody } from './_shared'
import { readRule, type RuleRollbackEntry } from './deploy'

const RULES_PATH = '/api/v2/security_monitoring/rules'

/**
 * Roll back Security Monitoring Rules using the state captured during deploy:
 *   - rules that were CREATED are deleted
 *     (DELETE /api/v2/security_monitoring/rules/{rule_id}; 404 tolerated —
 *     already gone is the desired end state)
 *     https://docs.datadoghq.com/api/latest/security-monitoring/ (delete)
 *   - rules that were UPDATED are restored (PUT, full-replace) to their
 *     captured prior body. The rule's `version` has advanced since deploy
 *     wrote it (Datadog's update is optimistic-concurrency controlled), so
 *     the CURRENT version is re-read immediately before the restoring PUT;
 *     the originally captured version is used only as a best-effort fallback
 *     if that re-read itself fails.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildDatadogClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RuleRollbackEntry[] } | null)?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${RULES_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete rule "${entry.label}": ${datadogErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        let version = entry.prior.version
        try {
          const fresh = await readRule(client, entry.id)
          if (typeof fresh.version === 'number') version = fresh.version
        } catch {
          // Best-effort — fall back to the version captured at deploy time.
        }

        const body = ruleToBody(entry.prior, version)
        const res = await client.request('PUT', `${RULES_PATH}/${encodeURIComponent(entry.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to restore rule "${entry.label}": ${datadogErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Security Monitoring Rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
