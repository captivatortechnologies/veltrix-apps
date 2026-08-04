import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPPClient, ppErrorMessage } from '../../lib/proofpoint'
import { scopeLabel, senderListsPath, SAFE_FIELD, BLOCKED_FIELD } from './validate'
import type { SenderRollbackData } from './deploy'

/**
 * Roll back sender-list changes using the state captured during deploy. Deploy
 * PATCHes the full desired array for whichever list(s) it changed in a scope, so
 * rollback PATCHes the exact prior array back for those same list(s) — restoring
 * the scope's Safe/Blocked lists verbatim without guessing at a removal request.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const scopes = (ctx.rollbackData as SenderRollbackData | undefined)?.scopes ?? []
  if (scopes.length === 0) {
    return { success: true, message: 'Nothing to roll back — this deploy changed no sender-list scope.' }
  }

  const reverted: string[] = []

  try {
    for (const entry of scopes) {
      if (!entry.changedAllow && !entry.changedBlock) continue

      const body: Record<string, unknown> = {}
      if (entry.changedAllow) body[SAFE_FIELD] = entry.priorAllowList
      if (entry.changedBlock) body[BLOCKED_FIELD] = entry.priorBlockList

      const res = await client.request('PATCH', senderListsPath(client, entry.scope, entry.scopeId), { body })
      if (!res.ok) {
        throw new Error(`Failed to restore sender lists for ${scopeLabel(entry.scope, entry.scopeId)}: ${ppErrorMessage(res)}`)
      }
      reverted.push(scopeLabel(entry.scope, entry.scopeId))
    }

    return { success: true, message: `Rolled back sender-list changes for ${reverted.length} scope(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${scopes.length} scope(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
