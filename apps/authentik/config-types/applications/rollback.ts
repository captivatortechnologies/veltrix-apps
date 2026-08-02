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
import { managedFieldsToPatchBody, type ManagedApplicationFields } from './_shared'

/**
 * Undo an applications deploy from `rollbackData.previous` (written by deploy()):
 * for each entry, PATCH /core/applications/{slug}/ with the prior managed fields
 * (restore), or — when the application was newly created (`prior` null) —
 * DELETE /core/applications/{slug}/ to remove it. Applied over the authentik
 * Core REST API. Entries are undone in reverse deploy order.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ slug: string; existed: boolean; prior: ManagedApplicationFields | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const token = resolveApiToken(credential)
  if (!token) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }

  const base = buildApiBase(buildAuthentikUrl(component, connectivity, connectivityProvider))
  const verifyTls = resolveVerifyTls(settings)

  let restored = 0
  let deleted = 0
  try {
    for (const entry of [...previous].reverse()) {
      const path = `${base}/core/applications/${encodeURIComponent(entry.slug)}/`
      if (entry.existed && entry.prior) {
        await sendJson('PATCH', path, token, managedFieldsToPatchBody(entry.prior), { verifyTls })
        restored++
      } else {
        await deleteResource(path, token, { verifyTls })
        deleted++
      }
    }
    return { success: true, message: `Rolled back applications: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
