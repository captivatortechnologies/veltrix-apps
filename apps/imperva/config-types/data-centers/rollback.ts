import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  DATA_CENTER_EDIT_PATH,
  DATA_CENTER_DELETE_PATH,
  DATA_CENTER_SERVER_ADD_PATH,
  DATA_CENTER_SERVER_EDIT_PATH,
  DATA_CENTER_SERVER_DELETE_PATH,
  isApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'

/**
 * Undo a data centers deploy from rollbackData.previous (written by deploy()):
 *   - a data center we CREATED → POST /sites/dataCenters/delete (cascades its servers).
 *   - a data center that PRE-EXISTED → restore its pool-level fields, then per server:
 *       - a server we ADDED (prior === null) → delete it.
 *       - a server we EDITED (prior + serverId both set) → edit it back.
 *       - a server we DELETED (prior set, serverId null) → re-add it (a NEW
 *         server id is assigned — content is restored, identity is not).
 */

interface PriorServerEntry {
  address: string
  serverId: string | number | null
  prior: { address: string; isStandby: boolean; isEnabled: boolean } | null
}
interface PriorEntry {
  siteId: string
  name: string
  dcId: string | number | null
  createdDc: boolean
  priorDc: { name: string; isContentOnly: boolean; isEnabled: boolean } | null
  servers: PriorServerEntry[]
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restoredDcs = 0
  let deletedDcs = 0
  let restoredServers = 0
  try {
    for (const entry of previous) {
      if (entry.createdDc) {
        if (entry.dcId != null) {
          const res = await client.post(DATA_CENTER_DELETE_PATH, { dc_id: entry.dcId })
          const json = parseJson<ImpervaEnvelope>(res.body)
          if (!res.ok || !isApiSuccess(json)) throw new Error(`delete data center "${entry.name}" → HTTP ${res.status}: ${apiMessage(json)}`)
          deletedDcs++
        }
        continue
      }

      if (entry.dcId != null && entry.priorDc) {
        const res = await client.post(DATA_CENTER_EDIT_PATH, {
          dc_id: entry.dcId,
          name: entry.priorDc.name,
          is_content: String(entry.priorDc.isContentOnly),
          is_enabled: String(entry.priorDc.isEnabled),
        })
        const json = parseJson<ImpervaEnvelope>(res.body)
        if (!res.ok || !isApiSuccess(json)) throw new Error(`restore data center "${entry.name}" → HTTP ${res.status}: ${apiMessage(json)}`)
        restoredDcs++
      }

      for (const server of entry.servers) {
        if (server.prior === null && server.serverId != null) {
          const res = await client.post(DATA_CENTER_SERVER_DELETE_PATH, { server_id: server.serverId })
          const json = parseJson<ImpervaEnvelope>(res.body)
          if (!res.ok || !isApiSuccess(json)) throw new Error(`delete server "${server.address}" → HTTP ${res.status}: ${apiMessage(json)}`)
        } else if (server.prior && server.serverId != null) {
          const res = await client.post(DATA_CENTER_SERVER_EDIT_PATH, {
            server_id: server.serverId,
            server_address: server.prior.address,
            is_standby: String(server.prior.isStandby),
            is_enabled: String(server.prior.isEnabled),
          })
          const json = parseJson<ImpervaEnvelope>(res.body)
          if (!res.ok || !isApiSuccess(json)) throw new Error(`restore server "${server.address}" → HTTP ${res.status}: ${apiMessage(json)}`)
        } else if (server.prior && server.serverId == null && entry.dcId != null) {
          const res = await client.post(DATA_CENTER_SERVER_ADD_PATH, {
            dc_id: entry.dcId,
            server_address: server.prior.address,
            is_standby: String(server.prior.isStandby),
            is_disabled: String(!server.prior.isEnabled),
          })
          const json = parseJson<ImpervaEnvelope>(res.body)
          if (!res.ok || !isApiSuccess(json)) throw new Error(`re-add server "${server.address}" → HTTP ${res.status}: ${apiMessage(json)}`)
        }
        restoredServers++
      }
    }
    return { success: true, message: `Rolled back data centers: ${restoredDcs} restored, ${deletedDcs} deleted, ${restoredServers} server change(s) undone.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
