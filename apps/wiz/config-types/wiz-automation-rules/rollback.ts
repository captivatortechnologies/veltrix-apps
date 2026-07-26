import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import type { FullAutomationRule } from './validate'
import type { AutomationRuleActionInput, AutomationRuleRollbackEntry } from './deploy'

const DELETE_AUTOMATION_RULE_MUTATION = `
mutation DeleteAutomationRule($input: DeleteAutomationRuleInput!) {
  deleteAutomationRule(input: $input) {
    _stub
  }
}`

const UPDATE_AUTOMATION_RULE_MUTATION = `
mutation UpdateAutomationRule($input: UpdateAutomationRuleInput!) {
  updateAutomationRule(input: $input) {
    automationRule { id }
  }
}`

/**
 * Roll back automation rules using the state captured during deploy:
 *   - rules that were created are deleted (deleteAutomationRule)
 *   - rules that were updated are restored to their captured prior SCALAR state
 *     (name, description, trigger source/types, filters, enabled). Wiz returns a
 *     rule's per-action parameters as a GraphQL union that cannot be read back
 *     generically, so the deploy's own action(s) are replayed to keep the
 *     restored rule valid — a modified rule's original action bodies are not
 *     recoverable through the API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AutomationRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(DELETE_AUTOMATION_RULE_MUTATION, { input: { id: entry.id } })
          if (res.transportError) throw new Error(`Failed to delete automation rule "${entry.label}": ${res.transportError}`)
          if (res.errors) throw new Error(`Failed to delete automation rule "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql(UPDATE_AUTOMATION_RULE_MUTATION, {
          input: { id: entry.id, patch: priorToPatch(entry.prior, entry.actions ?? []) },
        })
        if (res.transportError) throw new Error(`Failed to restore automation rule "${entry.label}": ${res.transportError}`)
        if (res.errors) throw new Error(`Failed to restore automation rule "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Wiz automation rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update patch from a captured prior rule state + the deploy's action(s). */
function priorToPatch(prior: FullAutomationRule, actions: AutomationRuleActionInput[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    name: prior.name ?? '',
    description: prior.description ?? '',
    triggerSource: prior.triggerSource ?? 'ISSUES',
    triggerType: Array.isArray(prior.triggerType) ? prior.triggerType : [],
    enabled: prior.enabled ?? true,
    actions,
  }
  if (prior.filters !== undefined && prior.filters !== null) patch.filters = prior.filters
  return patch
}
