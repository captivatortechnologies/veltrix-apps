import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/netskope'
import { serviceObjectBody } from './deploy'
import type { RollbackEntry } from './deploy'

const BASE = '/profiles/serviceobjects'

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
      const resp = await client.patch(
        `${BASE}/${e.id}`,
        serviceObjectBody({ itemId: e.itemId, name: e.prior.name, description: e.prior.description, icmp: e.prior.icmp, tcp: e.prior.tcp, udp: e.prior.udp, tcpUdp: e.prior.tcp_udp })
      )
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
  return { success: true, message: `Rolled back service objects: ${deleted} deleted, ${restored} restored` }
}
