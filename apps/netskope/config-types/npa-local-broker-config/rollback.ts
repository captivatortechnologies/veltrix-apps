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
  const priorHostname = typeof data?.priorHostname === 'string' ? data.priorHostname : null

  // Nothing recorded means nothing to restore. `?? ''` followed by an
  // unconditional PUT blanked the tenant-wide local-broker hostname whenever the
  // record was missing — writing an invented value in the name of an undo. The
  // other configuration types guard this with `if (!e.id) continue`; this one is
  // a singleton, so there was no per-entry loop to carry the rule.
  if (priorHostname === null) {
    return {
      success: false,
      message:
        'No prior local broker hostname was recorded, so nothing was restored. ' +
        'Writing an empty hostname would clear the tenant-wide setting rather than undo the deploy.',
    }
  }

  const resp = await client.put(BASE, { hostname: priorHostname })
  if (!resp.ok) {
    return { success: false, message: `Rollback failed: ${netskopeErrorMessage(resp)}` }
  }
  return { success: true, message: `Restored NPA local broker config (hostname: ${priorHostname || '(none)'})` }
}
