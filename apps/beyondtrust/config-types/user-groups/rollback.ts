import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, deletePath, withSession } from '../../lib/beyondtrustApi'

/**
 * Undo a user-groups deploy from rollbackData.previous (written by deploy()):
 * DELETE /UserGroups/<id> for every group WE created. Groups that already existed
 * before the deploy (action 'existing') are left as-is. A delete that fails —
 * e.g. the group owns secrets or the caller lacks admin — is skipped rather than
 * failing the whole rollback. Applied over the BeyondInsight REST API inside a
 * PS-Auth session.
 *
 * NOTE: verify DELETE /UserGroups/<id> against a live BeyondTrust instance.
 */
interface RollbackEntry {
  groupName: string
  groupId: number | string | null
  action: 'created' | 'existing'
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: RollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for user group rollback' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  let deleted = 0
  let skipped = 0

  try {
    await withSession(base, credential, async (cookie) => {
      for (const entry of previous) {
        if (entry.action !== 'created' || entry.groupId == null) {
          skipped++
          continue
        }
        try {
          await deletePath(base, `/UserGroups/${encodeURIComponent(String(entry.groupId))}`, cookie)
          deleted++
        } catch {
          // Group may own secrets or require admin to delete — leave it rather than fail.
          skipped++
        }
      }
    })
    return {
      success: true,
      message: `Rolled back user groups: ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
