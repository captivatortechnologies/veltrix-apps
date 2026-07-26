import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qpsWriteError } from '../../lib/qualys'
import { TAG_DELETE_PATH, TAG_UPDATE_PATH, buildTagRequest, type AssetTagRollbackEntry } from './deploy'
import { isDynamicRule, type AssetTagSpec } from './validate'

/**
 * Roll back asset tags using the state captured during deploy:
 *   - tags that were created are deleted (POST /delete/am/tag/{id})
 *   - tags that were updated are restored (POST /update/am/tag/{id}) to their
 *     prior name / rule / color / criticality
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AssetTagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.postJson(`${TAG_DELETE_PATH}/${encodeURIComponent(entry.id)}`, undefined)
          const failed = qpsWriteError(res)
          // A 404 / already-deleted tag is not a rollback failure.
          if (failed && res.status !== 404) {
            throw new Error(`Failed to delete tag "${entry.label}": ${failed}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const p = entry.prior
        const spec: AssetTagSpec = {
          sectionName: entry.label,
          name: p.name,
          ruleType: isDynamicRule(p.ruleType) ? p.ruleType : 'STATIC',
          ruleText: p.ruleText,
          color: p.color,
          criticalityScore: p.criticalityScore,
        }
        const res = await client.postJson(`${TAG_UPDATE_PATH}/${encodeURIComponent(entry.id)}`, buildTagRequest(spec))
        const failed = qpsWriteError(res)
        if (failed) throw new Error(`Failed to restore tag "${entry.label}": ${failed}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} asset tag(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
