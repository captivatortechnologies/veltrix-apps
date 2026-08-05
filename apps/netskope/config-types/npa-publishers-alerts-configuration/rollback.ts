import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import type { RollbackData } from './deploy'

const BASE = '/infrastructure/publishers/alertsconfiguration'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const data = ctx.rollbackData as RollbackData | undefined

  if (!data?.existed || !data.prior) {
    // Netskope's publishers-alerts-configuration endpoint has no DELETE
    // operation — a first-ever deploy cannot be un-set, only overwritten by a
    // future deploy. Nothing to restore.
    return { success: true, message: 'Nothing to restore — the publisher alerts configuration had not been set before this deploy, and this endpoint has no delete operation.' }
  }

  const resp = await client.put(BASE, {
    adminUsers: data.prior.adminUsers,
    eventTypes: data.prior.eventTypes,
    selectedUsers: data.prior.selectedUsers,
  })
  if (!resp.ok) {
    return { success: false, message: `Rollback failed: ${netskopeErrorMessage(resp)}` }
  }
  return { success: true, message: 'Restored the prior NPA publisher alerts configuration.' }
}
