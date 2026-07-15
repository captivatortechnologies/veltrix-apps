import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson, type OktaClient } from '../../lib/okta'
import { policiesPath, rulesPath, stripReadOnly, type LiveAuthServerPolicy } from './validate'
import type { AuthServerPolicyRollbackEntry } from './deploy'

/**
 * Roll back authorization-server policies (and their rules) using the state
 * captured during deploy:
 *   - policies that were CREATED are deleted (deleting a policy removes its
 *     rules too). A live system:true policy is REFUSED — never deleted.
 *   - policies that were UPDATED are restored (PUT) to their prior body and
 *     moved back to their prior status via the lifecycle endpoint.
 *   - rules that were CREATED are deleted; rules that were UPDATED are restored
 *     (PUT) to their prior body and prior status (via the rule lifecycle).
 * Deletes tolerate a 404 (already gone is the desired end state).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AuthServerPolicyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      const label = `${entry.authServerId}:${entry.name}`

      if (!entry.existed) {
        // Deploy created this policy — remove it (its rules go with it). Refuse
        // to delete a live system:true policy (a created policy is never system,
        // but never delete a system policy).
        if (entry.id) {
          if (await isSystemPolicy(client, entry.authServerId, entry.id)) {
            skipped.push(`${label} (system policy — not deleted)`)
            continue
          }
          const res = await client.request('DELETE', `${policiesPath(entry.authServerId)}/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete authorization-server policy "${label}": ${oktaErrorMessage(res)}`)
          }
        }
      } else if (entry.id) {
        // Deploy updated this policy — restore the prior body, then its rules,
        // then its prior status.
        if (entry.priorPolicy) {
          const res = await client.request('PUT', `${policiesPath(entry.authServerId)}/${entry.id}`, {
            body: stripReadOnly(entry.priorPolicy),
          })
          if (!res.ok) {
            throw new Error(`Failed to restore authorization-server policy "${label}": ${oktaErrorMessage(res)}`)
          }
        }

        for (const rule of [...entry.rules].reverse()) {
          if (!rule.existed) {
            // Deploy created this rule — remove it (tolerate 404).
            const res = await client.request('DELETE', `${rulesPath(entry.authServerId, entry.id)}/${rule.id}`)
            if (res.status !== 404 && !res.ok) {
              throw new Error(
                `Failed to delete rule "${rule.name}" on authorization-server policy "${label}": ${oktaErrorMessage(res)}`,
              )
            }
          } else if (rule.prior) {
            // Deploy updated this rule — restore its prior body, then its status.
            const res = await client.request('PUT', `${rulesPath(entry.authServerId, entry.id)}/${rule.id}`, {
              body: stripReadOnly(rule.prior),
            })
            if (!res.ok) {
              throw new Error(
                `Failed to restore rule "${rule.name}" on authorization-server policy "${label}": ${oktaErrorMessage(res)}`,
              )
            }
            if (rule.priorStatus) {
              await restoreRuleStatus(client, entry.authServerId, entry.id, rule.id, rule.priorStatus, rule.name, label)
            }
          }
        }

        // Restore the prior status via the lifecycle endpoint.
        if (entry.priorStatus) {
          await restorePolicyStatus(client, entry.authServerId, entry.id, entry.priorStatus, label)
        }
      }

      reverted.push(label)
    }

    const skipNote = skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} authorization-server policy(ies): ${reverted.join(', ')}.${skipNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** True when the policy is live and system-managed (system:true). */
async function isSystemPolicy(client: OktaClient, authServerId: string, policyId: string): Promise<boolean> {
  const res = await client.request('GET', `${policiesPath(authServerId)}/${policyId}`)
  if (!res.ok) return false
  return parseJson<LiveAuthServerPolicy>(res.body)?.system === true
}

/** Move a policy back to its prior status via the lifecycle endpoint (tolerate 404). */
async function restorePolicyStatus(
  client: OktaClient,
  authServerId: string,
  policyId: string,
  priorStatus: string,
  label: string,
): Promise<void> {
  const action = priorStatus.toUpperCase() === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `${policiesPath(authServerId)}/${policyId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to restore status of authorization-server policy "${label}": ${oktaErrorMessage(res)}`)
  }
}

/** Move a rule back to its prior status via the rule lifecycle endpoint (tolerate 404). */
async function restoreRuleStatus(
  client: OktaClient,
  authServerId: string,
  policyId: string,
  ruleId: string,
  priorStatus: string,
  name: string,
  label: string,
): Promise<void> {
  const action = priorStatus.toUpperCase() === 'ACTIVE' ? 'activate' : 'deactivate'
  const res = await client.request('POST', `${rulesPath(authServerId, policyId)}/${ruleId}/lifecycle/${action}`)
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Failed to restore status of rule "${name}" on authorization-server policy "${label}": ${oktaErrorMessage(res)}`,
    )
  }
}
