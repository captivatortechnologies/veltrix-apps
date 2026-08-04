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
import { managedFieldsToPatchBody, POLICY_ENDPOINT_SEGMENT, type ManagedPolicyFields, type PolicyType } from './_shared'

/** Undo a policies deploy from `rollbackData.previous`. Reverse deploy order. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; type: PolicyType; pk: string | null; existed: boolean; prior: ManagedPolicyFields | null }>
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
      const path = `${base}/policies/${POLICY_ENDPOINT_SEGMENT[entry.type]}/${encodeURIComponent(entry.pk)}/`
      if (entry.existed && entry.prior) {
        await sendJson('PATCH', path, token, managedFieldsToPatchBody(entry.prior), { verifyTls })
        restored++
      } else {
        await deleteResource(path, token, { verifyTls })
        deleted++
      }
    }
    return { success: true, message: `Rolled back policies: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
