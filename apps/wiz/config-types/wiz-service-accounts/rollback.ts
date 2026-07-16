import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import type { ServiceAccountRollbackEntry } from './deploy'

const DELETE_SERVICE_ACCOUNT_MUTATION = `
mutation DeleteServiceAccount($input: DeleteServiceAccountInput!) {
  deleteServiceAccount(input: $input) {
    _stub
  }
}`

/**
 * Roll back Wiz service accounts using the state captured during deploy:
 *   - accounts that were created are deleted (deleteServiceAccount)
 *   - accounts that already existed are left untouched (deploy never modifies
 *     them, so there is nothing to restore)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ServiceAccountRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed && entry.id) {
        const res = await client.graphql(DELETE_SERVICE_ACCOUNT_MUTATION, { input: { id: entry.id } })
        if (res.transportError) {
          throw new Error(`Failed to delete service account "${entry.label}": ${res.transportError}`)
        }
        if (res.errors) {
          throw new Error(`Failed to delete service account "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        }
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Wiz service account(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
