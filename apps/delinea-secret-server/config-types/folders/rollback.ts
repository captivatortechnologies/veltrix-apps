import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import type { LiveFolder } from './_shared'
import type { FolderRollbackEntry } from './deploy'

/**
 * Undo a folders deploy from rollbackData.previous (written by deploy()): for
 * each folder that already existed, PATCH /folders/{id} to restore its prior
 * body; a newly created folder (existed=false) is left in place — folder
 * deletion over this seam is destructive (it removes contained secrets) and is
 * skipped. Applied over the Secret Server REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: FolderRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let left = 0
  try {
    for (const entry of previous) {
      if (!entry.existed || !entry.prior || entry.folderId === null) {
        // A newly created folder (or one whose id we never learned) — leave it in place.
        left++
        continue
      }
      const res = await client.request('PATCH', `/folders/${entry.folderId}`, { body: restoreBody(entry.prior) })
      if (!res.ok) throw new Error(`Failed to restore folder "${entry.folderName}": ${secretServerErrorMessage(res)}`)
      restored++
    }
    return { success: true, message: `Rolled back folders: ${restored} restored${left ? `, ${left} left in place` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

/** Restore body for a prior folder — only the fields this app manages. */
function restoreBody(prior: LiveFolder): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.folderName !== undefined) body.folderName = prior.folderName
  if (prior.inheritPermissions !== undefined) body.inheritPermissions = prior.inheritPermissions
  if (prior.inheritSecretPolicy !== undefined) body.inheritSecretPolicy = prior.inheritSecretPolicy
  if (prior.id !== undefined) body.id = prior.id
  if (prior.folderTypeId !== undefined) body.folderTypeId = prior.folderTypeId
  return body
}
