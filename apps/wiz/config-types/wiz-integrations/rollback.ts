import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import { buildIntegrationPatch } from './deploy'
import type { IntegrationRollbackEntry } from './deploy'

const DELETE_INTEGRATION_MUTATION = `
mutation DeleteIntegration($input: DeleteIntegrationInput!) {
  deleteIntegration(input: $input) {
    _stub
  }
}`

const UPDATE_INTEGRATION_MUTATION = `
mutation UpdateIntegration($input: UpdateIntegrationInput!) {
  updateIntegration(input: $input) {
    integration { id }
  }
}`

/**
 * Roll back integrations using the state captured during deploy:
 *   - integrations that were created are deleted (deleteIntegration)
 *   - integrations that were updated are restored to the FULL prior spec this
 *     app declared on the previous deploy (ctx.previousConfig, captured at
 *     deploy time) — never a live API read, since every vendor credential here
 *     is write-only by design. An entry with no captured prior (e.g. the
 *     integration existed before this app ever managed it) is left as-is and
 *     reported, rather than guessing at a restore.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IntegrationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(DELETE_INTEGRATION_MUTATION, { input: { id: entry.id } })
          if (res.transportError) throw new Error(`Failed to delete integration "${entry.label}": ${res.transportError}`)
          if (res.errors) throw new Error(`Failed to delete integration "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        }
        reverted.push(entry.label)
      } else if (entry.id && entry.prior) {
        const res = await client.graphql(UPDATE_INTEGRATION_MUTATION, {
          input: { id: entry.id, patch: buildIntegrationPatch(entry.prior) },
        })
        if (res.transportError) throw new Error(`Failed to restore integration "${entry.label}": ${res.transportError}`)
        if (res.errors) throw new Error(`Failed to restore integration "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        reverted.push(entry.label)
      } else {
        // No prior captured (existed before this app first managed it) — nothing safe to restore.
        skipped.push(entry.label)
      }
    }

    const skippedNote = skipped.length > 0 ? ` (no prior state captured, left unchanged: ${skipped.join(', ')})` : ''
    return { success: true, message: `Rolled back ${reverted.length} Wiz integration(s): ${reverted.join(', ')}${skippedNote}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
