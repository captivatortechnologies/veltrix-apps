import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/prismacloud'
import type { RollbackEntry } from './deploy'

const BASE = '/settings/enterprise'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entry = Array.isArray(data?.entries) ? data!.entries[0] : undefined
  if (!entry?.prior) {
    return { success: true, message: 'No prior enterprise settings snapshot to restore' }
  }

  // Restore the full prior singleton snapshot.
  const resp = await client.put(BASE, entry.prior)
  if (!resp.ok) return { success: false, message: `Rollback failed: ${pcErrorMessage(resp)}` }
  return { success: true, message: 'Restored prior enterprise settings' }
}
