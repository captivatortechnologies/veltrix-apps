import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import type { FullHostConfigRule } from './validate'
import type { HostConfigRuleRollbackEntry } from './deploy'

const DELETE_HOST_CONFIG_RULE_MUTATION = `
mutation DeleteHostConfigurationRule($input: DeleteHostConfigurationRuleInput!) {
  deleteHostConfigurationRule(input: $input) {
    _stub
  }
}`

const UPDATE_HOST_CONFIG_RULE_MUTATION = `
mutation UpdateHostConfigurationRule($input: UpdateHostConfigurationRuleInput!) {
  updateHostConfigurationRule(input: $input) {
    rule { id }
  }
}`

/**
 * Roll back host configuration rules using the state captured during deploy:
 *   - rules that were created are deleted (deleteHostConfigurationRule)
 *   - rules that were updated are restored to their captured prior state via an
 *     update patch (updateHostConfigurationRule)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: HostConfigRuleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(DELETE_HOST_CONFIG_RULE_MUTATION, { input: { id: entry.id } })
          if (res.transportError) throw new Error(`Failed to delete rule "${entry.label}": ${res.transportError}`)
          if (res.errors) throw new Error(`Failed to delete rule "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql(UPDATE_HOST_CONFIG_RULE_MUTATION, {
          input: { id: entry.id, patch: priorToPatch(entry.prior) },
        })
        if (res.transportError) throw new Error(`Failed to restore rule "${entry.label}": ${res.transportError}`)
        if (res.errors) throw new Error(`Failed to restore rule "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Wiz host configuration rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update patch from a captured prior rule state. */
function priorToPatch(prior: FullHostConfigRule): Record<string, unknown> {
  const ids = (list: Array<{ id?: string }> | undefined): string[] =>
    (list ?? []).map((x) => x.id).filter((id): id is string => typeof id === 'string' && id.length > 0)

  return {
    name: prior.name ?? '',
    description: prior.description ?? '',
    directOVAL: prior.directOVAL ?? '',
    targetPlatformIds: ids(prior.targetPlatforms),
    enabled: prior.enabled ?? true,
    securitySubCategories: ids(prior.securitySubCategories),
  }
}
