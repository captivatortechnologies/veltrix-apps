import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildIntuneClient, graphErrorMessage } from '../../lib/intune'
import { BUILT_IN_SCOPE_TAG_ID, SCOPE_TAGS_PATH, type ScopeTagRollbackEntry } from './deploy'

const SCOPE_TAG_ODATA_TYPE = '#microsoft.graph.roleScopeTag'

/**
 * Roll back role scope tags using the state captured during deploy: tags this
 * deploy created are deleted; tags it updated are restored to their prior
 * name/description. The built-in Default tag (id "0") is never captured for
 * update and never created, so rollback can never delete or alter it — but the
 * id is guarded here as a final safety net.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildIntuneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScopeTagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      // Never delete or restore the built-in Default tag, whatever the state says.
      if (entry.id === BUILT_IN_SCOPE_TAG_ID) {
        reverted.push(entry.name)
        continue
      }

      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${SCOPE_TAGS_PATH}/${entry.id}`)
          if (res.status !== 404 && !res.ok) throw new Error(`Failed to delete scope tag "${entry.name}": ${graphErrorMessage(res)}`)
        }
      } else if (entry.id && entry.prior) {
        const body = {
          '@odata.type': SCOPE_TAG_ODATA_TYPE,
          displayName: entry.prior.displayName ?? entry.name,
          description: entry.prior.description ?? '',
        }
        const res = await client.request('PATCH', `${SCOPE_TAGS_PATH}/${entry.id}`, { body })
        if (!res.ok) throw new Error(`Failed to restore scope tag "${entry.name}": ${graphErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} role scope tag(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
