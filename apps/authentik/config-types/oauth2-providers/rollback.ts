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
import { managedFieldsToPatchBody, type ManagedOAuth2ProviderFields } from './_shared'

/**
 * Undo an OAuth2/OpenID providers deploy from `rollbackData.previous` (written
 * by deploy()): for each entry, PATCH /providers/oauth2/{pk}/ with the prior
 * managed fields (restore), or — when the provider was newly created (`prior`
 * null) — DELETE /providers/oauth2/{pk}/ to remove it. An entry whose `pk` was
 * never learned (a create whose response omitted it) is skipped — nothing safe
 * to undo. Entries are undone in reverse deploy order.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; pk: number | null; existed: boolean; prior: ManagedOAuth2ProviderFields | null }>
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
      if (entry.pk == null) {
        skipped++
        continue
      }
      const path = `${base}/providers/oauth2/${entry.pk}/`
      if (entry.existed && entry.prior) {
        await sendJson('PATCH', path, token, managedFieldsToPatchBody(entry.prior), { verifyTls })
        restored++
      } else {
        await deleteResource(path, token, { verifyTls })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back OAuth2/OpenID providers: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
