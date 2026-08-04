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
import { managedFieldsToPatchBody, SOURCE_ENDPOINT_SEGMENT, type ManagedSourceFields, type SourceType } from './_shared'

/**
 * Undo a sources deploy from `rollbackData.previous`: PATCH prior managed
 * fields back (never including a secret — see _shared.ts), or DELETE a
 * source this deploy created. Reverse deploy order.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ slug: string; type: SourceType; existed: boolean; prior: ManagedSourceFields | null }>
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
      const path = `${base}/sources/${SOURCE_ENDPOINT_SEGMENT[entry.type]}/${encodeURIComponent(entry.slug)}/`
      if (entry.existed && entry.prior) {
        await sendJson('PATCH', path, token, managedFieldsToPatchBody(entry.prior), { verifyTls })
        restored++
      } else {
        await deleteResource(path, token, { verifyTls })
        deleted++
      }
    }
    return { success: true, message: `Rolled back sources: ${restored} restored, ${deleted} deleted.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
