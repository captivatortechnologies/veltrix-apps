import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import {
  bodyFromLive,
  deleteGroupRule,
  lifecycleTransition,
  type GroupRuleRollbackEntry,
} from './deploy'

/**
 * Roll back group rules using the state captured during deploy. Each entry is
 * reverted according to how deploy changed the rule:
 *   - created → delete the new rule (deactivate → delete, tolerating 404).
 *   - updated → restore the captured prior body in place: deactivate → PUT the
 *     prior name/expression → restore the prior status. The target groups were
 *     unchanged, so a PUT is valid here.
 *   - rebuilt → delete the recreated rule, then POST the captured prior rule
 *     back (a NEW id) and restore its prior status. This undoes the immutable-
 *     actions delete + recreate deploy had to perform.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GroupRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Revert in reverse order so later changes are undone before earlier ones.
    for (const entry of [...previousState].reverse()) {
      const label = entry.name

      if (entry.action === 'created') {
        // Deploy created this rule — remove it entirely.
        if (entry.liveId) {
          await deleteGroupRule(client, entry.liveId, label)
        }
      } else if (entry.action === 'updated') {
        // Deploy updated this rule in place — restore the captured prior body,
        // then the prior status. A PUT needs the rule INACTIVE first.
        if (entry.liveId && entry.prior) {
          await ensureInactive(client, entry.liveId, label)
          const res = await client.request('PUT', `/groups/rules/${entry.liveId}`, {
            body: bodyFromLive(entry.prior),
          })
          if (!res.ok) {
            throw new Error(`Failed to restore group rule "${label}": ${oktaErrorMessage(res)}`)
          }
          if ((entry.prior.status ?? '').toUpperCase() === 'ACTIVE') {
            await lifecycleTransition(client, entry.liveId, 'activate', label)
          }
        }
      } else if (entry.action === 'rebuilt') {
        // Deploy deleted + recreated this rule (immutable actions). Delete the
        // recreation, then bring the original back and restore its status.
        if (entry.liveId) {
          await deleteGroupRule(client, entry.liveId, label)
        }
        if (entry.prior) {
          const res = await client.request('POST', '/groups/rules', { body: bodyFromLive(entry.prior) })
          if (!res.ok) {
            throw new Error(`Failed to recreate prior group rule "${label}": ${oktaErrorMessage(res)}`)
          }
          if ((entry.prior.status ?? '').toUpperCase() === 'ACTIVE') {
            const recreated = parseJson<{ id?: string }>(res.body)
            if (recreated?.id) {
              await lifecycleTransition(client, recreated.id, 'activate', label)
            }
          }
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} group rule(s): ${reverted.join(', ')}. Rules rebuilt for an immutable target-group change were recreated with new ids.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/**
 * Deactivate a rule so it can accept a PUT, tolerating a rule that is already
 * INACTIVE (or gone). A genuinely unexpected failure is surfaced.
 */
async function ensureInactive(client: OktaClient, id: string, label: string): Promise<void> {
  const res = await client.request('POST', `/groups/rules/${id}/lifecycle/deactivate`)
  if (!res.ok && res.status !== 404 && res.status !== 400) {
    throw new Error(`Failed to deactivate group rule "${label}" before restore: ${oktaErrorMessage(res)}`)
  }
}
