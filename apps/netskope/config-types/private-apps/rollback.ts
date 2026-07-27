import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import type { RollbackEntry } from './deploy'

const BASE = '/steering/apps/private'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0
  let deleted = 0

  for (const e of entries) {
    if (!e.id) continue
    if (e.existed && e.prior) {
      const resp = await client.put(`${BASE}/${e.id}`, {
        app_name: e.prior.app_name,
        host: e.prior.host,
        protocols: e.prior.protocols,
        publishers: e.prior.publishers,
        clientless_access: e.prior.clientless_access,
        use_publisher_dns: e.prior.use_publisher_dns,
        trust_self_signed_certs: e.prior.trust_self_signed_certs,
      })
      if (!resp.ok && resp.status !== 404) failures.push(`restore ${e.name}: ${netskopeErrorMessage(resp)}`)
      else restored++
    } else if (!e.existed) {
      const resp = await client.delete(`${BASE}/${e.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${e.name}: ${netskopeErrorMessage(resp)}`)
      else deleted++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back private apps: ${deleted} deleted, ${restored} restored` }
}
