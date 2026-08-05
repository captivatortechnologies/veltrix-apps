import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import type { RollbackData } from './deploy'

const BASE = '/infrastructure/lbrokers/brokerconfig'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const data = ctx.rollbackData as RollbackData | undefined
  const priorHostname = data?.priorHostname ?? ''

  const resp = await client.put(BASE, { hostname: priorHostname })
  if (!resp.ok) {
    return { success: false, message: `Rollback failed: ${netskopeErrorMessage(resp)}` }
  }
  return { success: true, message: `Restored NPA local broker config (hostname: ${priorHostname || '(none)'})` }
}
