import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import { PATH, type RollbackEntry } from './deploy'

/** Properties Graph accepts on a PATCH of the default policy (its update body). */
const WRITABLE_DEFAULT_KEYS = new Set([
  'appServiceConnectInbound',
  'b2bCollaborationInbound',
  'b2bCollaborationOutbound',
  'b2bDirectConnectInbound',
  'b2bDirectConnectOutbound',
  'inboundTrust',
  'm365CollaborationInbound',
  'm365CollaborationOutbound',
  'tenantRestrictions',
])

/** Keep only the writable, non-null keys so a restore PATCH is never rejected. */
function writableSubset(prior: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(prior)) {
    if (WRITABLE_DEFAULT_KEYS.has(key) && prior[key] != null) out[key] = prior[key]
  }
  return out
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entry = Array.isArray(data?.entries) ? data.entries[0] : undefined
  if (!entry) return { success: true, message: 'Nothing to roll back' }

  // The default policy is never deleted. If it was still the untouched system
  // default before deploy, resetToSystemDefault is the faithful restore;
  // otherwise PATCH the writable subset of the prior policy back.
  if (entry.wasServiceDefault) {
    const resp = await client.post(`${PATH}/resetToSystemDefault`, undefined)
    if (!resp.ok) return { success: false, message: `Rollback (reset) failed: ${graphErrorMessage(resp)}` }
    return { success: true, message: 'Rolled back the cross-tenant default policy to the system default' }
  }

  const body = writableSubset(entry.previousState ?? {})
  const resp = await client.patch(PATH, body)
  if (!resp.ok) return { success: false, message: `Rollback (restore) failed: ${graphErrorMessage(resp)}` }
  return { success: true, message: 'Restored the prior cross-tenant access default policy' }
}
