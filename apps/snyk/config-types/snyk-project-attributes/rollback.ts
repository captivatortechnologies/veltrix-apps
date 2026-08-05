import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient, snykErrorMessage } from '../../lib/snyk'
import type { ProjectAttributesRollbackEntry } from './deploy'
import { tagsRecordToArray } from './validate'

/**
 * Roll back project attributes by re-applying the values captured before
 * deploy. The owner relationship is always included (even when unset, sending
 * a null id) so a deploy that set an owner is fully reversed rather than left
 * in place.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasOrg) {
    return { success: false, message: 'No Snyk organization id set — cannot roll back project attributes.' }
  }

  const previousState = (ctx.rollbackData as { previousState?: ProjectAttributesRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const attrs: Record<string, unknown> = {
        business_criticality: entry.prior.businessCriticality,
        environment: entry.prior.environment,
        lifecycle: entry.prior.lifecycle,
        tags: tagsRecordToArray(entry.prior.tags),
      }
      if (entry.prior.testFrequency) attrs.test_frequency = entry.prior.testFrequency

      const res = await client.rest('PATCH', `${client.restOrgPath()}/projects/${entry.projectId}`, {
        body: {
          data: {
            id: entry.projectId,
            type: 'project',
            attributes: attrs,
            relationships: { owner: { data: { id: entry.prior.ownerUserId || null, type: 'user' } } },
          },
        },
      })
      if (!res.ok) throw new Error(`Failed to restore project "${entry.projectId}": ${snykErrorMessage(res)}`)
      reverted.push(entry.projectId)
    }

    return {
      success: true,
      message: `Restored ${reverted.length} project(s) to their prior attributes: ${reverted.join(', ') || 'none'}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
