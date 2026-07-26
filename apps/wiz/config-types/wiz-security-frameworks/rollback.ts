import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import { priorCategoriesToInput } from './deploy'
import type { FullSecurityFramework } from './validate'
import type { SecurityFrameworkRollbackEntry } from './deploy'

const DELETE_SECURITY_FRAMEWORK_MUTATION = `
mutation DeleteSecurityFramework($input: DeleteSecurityFrameworkInput!) {
  deleteSecurityFramework(input: $input) {
    _stub
  }
}`

const UPDATE_SECURITY_FRAMEWORK_MUTATION = `
mutation UpdateSecurityFramework($input: UpdateSecurityFrameworkInput!) {
  updateSecurityFramework(input: $input) {
    framework { id }
  }
}`

/**
 * Roll back security frameworks using the state captured during deploy:
 *   - frameworks that were created are deleted (deleteSecurityFramework)
 *   - frameworks that were updated are restored to their captured prior state via
 *     an update patch (updateSecurityFramework), preserving category ids
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SecurityFrameworkRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(DELETE_SECURITY_FRAMEWORK_MUTATION, { input: { id: entry.id } })
          if (res.transportError) throw new Error(`Failed to delete security framework "${entry.label}": ${res.transportError}`)
          if (res.errors) throw new Error(`Failed to delete security framework "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql(UPDATE_SECURITY_FRAMEWORK_MUTATION, {
          input: { id: entry.id, patch: priorToPatch(entry.prior) },
        })
        if (res.transportError) throw new Error(`Failed to restore security framework "${entry.label}": ${res.transportError}`)
        if (res.errors) throw new Error(`Failed to restore security framework "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Wiz security framework(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update patch from a captured prior framework state. */
function priorToPatch(prior: FullSecurityFramework): Record<string, unknown> {
  return {
    name: prior.name ?? '',
    description: prior.description ?? '',
    enabled: prior.enabled ?? true,
    categories: priorCategoriesToInput(prior.categories),
  }
}
