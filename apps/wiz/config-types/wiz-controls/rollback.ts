import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage } from '../../lib/wiz'
import type { FullControl } from './validate'
import type { ControlRollbackEntry } from './deploy'

const DELETE_CONTROL_MUTATION = `
mutation DeleteControl($input: DeleteControlInput!) {
  deleteControl(input: $input) {
    _stub
  }
}`

const UPDATE_CONTROL_MUTATION = `
mutation UpdateControl($input: UpdateControlInput!) {
  updateControl(input: $input) {
    control { id }
  }
}`

/**
 * Roll back controls using the state captured during deploy:
 *   - controls that were created are deleted (deleteControl)
 *   - controls that were updated are restored to their captured prior state via
 *     an update patch (updateControl) — the project scope (`projectId`) is
 *     never included, since Wiz has no API to change it after creation.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ControlRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql(DELETE_CONTROL_MUTATION, { input: { id: entry.id } })
          if (res.transportError) throw new Error(`Failed to delete control "${entry.label}": ${res.transportError}`)
          if (res.errors) throw new Error(`Failed to delete control "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql(UPDATE_CONTROL_MUTATION, {
          input: { id: entry.id, patch: priorToPatch(entry.prior) },
        })
        if (res.transportError) throw new Error(`Failed to restore control "${entry.label}": ${res.transportError}`)
        if (res.errors) throw new Error(`Failed to restore control "${entry.label}": ${graphqlErrorMessage(res.errors)}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Wiz control(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update patch from a captured prior control state. */
function priorToPatch(prior: FullControl): Record<string, unknown> {
  const ids = (list: Array<{ id?: string }> | undefined): string[] =>
    (list ?? []).map((x) => x.id).filter((id): id is string => typeof id === 'string' && id.length > 0)

  return {
    name: prior.name ?? '',
    description: prior.description ?? '',
    resolutionRecommendation: prior.resolutionRecommendation ?? '',
    severity: prior.severity ?? 'MEDIUM',
    enabled: prior.enabled ?? true,
    query: prior.query,
    scopeQuery: prior.scopeQuery,
    securitySubCategories: ids(prior.securitySubCategories),
  }
}
