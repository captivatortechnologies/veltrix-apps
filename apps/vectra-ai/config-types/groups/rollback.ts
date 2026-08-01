import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, sendJson } from '../../lib/vectraApi'
import { normalizeMembers, type VectraGroup } from './_shared'

/**
 * Undo a groups deploy from rollbackData.previous (written by deploy()): for each
 * entry, PATCH /groups/<id> with the prior group's name/description/members
 * (restore), or — when the group was newly created (prior body null) — DELETE
 * /groups/<id> to remove it. Applied over the Vectra Detect REST API (v2.5, 443).
 *
 * The prior group came from a GET whose `members` may be expanded objects, so they
 * are collapsed back to ids/strings via normalizeMembers before the restore PATCH.
 * Verify against a live Vectra brain.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; groupId: number | string | null; group: VectraGroup | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for group rollback' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { groupId, group } of previous) {
      if (groupId == null) {
        // A created group whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (group) {
        const body: VectraGroup = {
          name: String(group.name ?? '').trim(),
          description: String(group.description ?? '').trim(),
          members: normalizeMembers(group.members, String(group.type ?? '').trim()),
        }
        await sendJson('PATCH', `${base}/groups/${encodeURIComponent(String(groupId))}`, headers, body)
        restored++
      } else {
        await sendJson('DELETE', `${base}/groups/${encodeURIComponent(String(groupId))}`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back groups: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
