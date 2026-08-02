import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildAuthentikUrl,
  buildApiBase,
  resolveApiToken,
  resolveVerifyTls,
  sendJson,
  deleteResource,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/authentikApi'
import { managedFieldsToPatchBody, type ManagedGroupFields } from './_shared'

/**
 * Undo a groups deploy from `rollbackData.previous` (written by deploy()): for
 * each entry, PATCH /core/groups/{group_uuid}/ with the prior managed fields
 * (restore), or — when the group was newly created (`prior` null) — DELETE
 * /core/groups/{group_uuid}/ to remove it. An entry whose `pk` was never
 * learned is skipped. Entries are undone in reverse deploy order.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; pk: string | null; existed: boolean; prior: ManagedGroupFields | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const token = resolveApiToken(credential)
  if (!token) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.pk) {
        skipped++
        continue
      }
      const path = `${base}/core/groups/${encodeURIComponent(entry.pk)}/`
      if (entry.existed && entry.prior) {
        await sendJson('PATCH', path, token, managedFieldsToPatchBody(entry.prior), { verifyTls })
        restored++
      } else {
        await deleteResource(path, token, { verifyTls })
        deleted++
      }
    }
    return { success: true, message: `Rolled back groups: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
