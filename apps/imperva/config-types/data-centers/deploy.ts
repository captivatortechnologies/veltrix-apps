import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildImpervaClient,
  DATA_CENTER_ADD_PATH,
  DATA_CENTER_EDIT_PATH,
  DATA_CENTER_LIST_PATH,
  DATA_CENTER_SERVER_ADD_PATH,
  DATA_CENTER_SERVER_EDIT_PATH,
  DATA_CENTER_SERVER_DELETE_PATH,
  isApiSuccess,
  apiMessage,
  parseJson,
  type ImpervaClient,
  type ImpervaEnvelope,
} from '../../lib/impervaApi'
import {
  dataCentersFromResponse,
  findDataCenter,
  findServer,
  readDataCenterFields,
  toBool,
  type DataCenterFields,
  type DataCenterStatus,
  type ServerFields,
} from './_shared'

/**
 * Deploy Imperva Cloud WAF data centers (origin server pools) over the legacy
 * v1 API:
 *   read (identity/rollback): POST /sites/dataCenters/list        { site_id }
 *   create pool + 1st server: POST /sites/dataCenters/add         { site_id, name, server_address, is_content, is_enabled }
 *   edit pool:                POST /sites/dataCenters/edit        { dc_id, name, is_content, is_enabled }
 *   add a server:             POST /sites/dataCenters/servers/add { dc_id, server_address, is_standby, is_disabled }
 *   edit a server:             POST /sites/dataCenters/servers/edit { server_id, server_address, is_standby, is_enabled }
 *
 * NOTE the real API asymmetry: servers/add takes `is_disabled` (inverted),
 * servers/edit takes `is_enabled` (direct) — both honored exactly below.
 *
 * The data center NAME is the identity within a site; a server's ADDRESS is the
 * identity within a data center. `rollbackData.previous` records, per item,
 * whether the data center pre-existed (and its prior body) or was created
 * (rollback deletes it), plus one entry per server touched (added/edited/
 * removed) so rollback can undo each individually.
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

async function listDataCenters(client: ImpervaClient, siteId: string): Promise<DataCenterStatus[]> {
  const res = await client.post(DATA_CENTER_LIST_PATH, { site_id: siteId })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) {
    throw new Error(`list data centers for site ${siteId} → HTTP ${res.status}: ${apiMessage(json)}`)
  }
  return dataCentersFromResponse(json)
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []
  const dcsBySite = new Map<string, DataCenterStatus[]>()
  const loadDcs = async (siteId: string): Promise<DataCenterStatus[]> => {
    if (!dcsBySite.has(siteId)) dcsBySite.set(siteId, await listDataCenters(client, siteId))
    return dcsBySite.get(siteId) ?? []
  }

  try {
    for (const item of items) {
      const fields = readDataCenterFields(item.fields)
      if (!fields.siteId || !fields.name || fields.servers.length === 0) continue

      const existing = findDataCenter(await loadDcs(fields.siteId), fields.name)
      const entry = existing
        ? await reconcileExisting(client, fields, existing)
        : await createNew(client, fields)

      previous.push(entry)
      applied.push(`${fields.name} (site ${fields.siteId})`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} data center(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Data center deploy failed after ${applied.length} data center(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

/** Create a new data center (with its first server) and add any remaining declared servers. */
async function createNew(client: ImpervaClient, fields: DataCenterFields): Promise<PriorEntry> {
  const [first, ...rest] = fields.servers

  const addRes = await client.post(DATA_CENTER_ADD_PATH, {
    site_id: fields.siteId,
    name: fields.name,
    server_address: first.address,
    is_content: String(fields.isContentOnly),
    is_enabled: String(fields.isEnabled),
  })
  const addJson = parseJson<{ res?: number | string; datacenter_id?: string }>(addRes.body)
  if (!addRes.ok || !isApiSuccess(addJson as ImpervaEnvelope)) {
    throw new Error(`create data center "${fields.name}" (site ${fields.siteId}) → HTTP ${addRes.status}: ${apiMessage(addJson as ImpervaEnvelope)}`)
  }
  const dcId = addJson?.datacenter_id ?? null

  const servers: PriorServerEntry[] = []

  // The auto-created first server's own standby/enabled state can't be set on
  // add (only the pool-level is_enabled above) — look it up, then converge it.
  if (dcId != null) {
    const created = findDataCenter(await listDataCenters(client, fields.siteId), fields.name)
    const createdFirstServer = created?.servers?.find((s) => String(s.address ?? '').trim().toLowerCase() === first.address.toLowerCase())
    const firstServerId = createdFirstServer?.id ?? null
    if (firstServerId != null && (toBool(createdFirstServer?.isStandBy, false) !== first.isStandby || toBool(createdFirstServer?.enabled, true) !== first.isEnabled)) {
      await editServer(client, firstServerId, first)
    }
    servers.push({ address: first.address, serverId: firstServerId, prior: null })

    for (const server of rest) {
      const serverId = await addServer(client, dcId, server)
      servers.push({ address: server.address, serverId, prior: null })
    }
  }

  return { siteId: fields.siteId, name: fields.name, dcId, createdDc: true, priorDc: null, servers }
}

/** Edit an existing data center's pool-level fields and reconcile its servers by address. */
async function reconcileExisting(client: ImpervaClient, fields: DataCenterFields, existing: DataCenterStatus): Promise<PriorEntry> {
  const dcId = existing.id ?? null
  const priorDc = {
    name: String(existing.name ?? fields.name),
    isContentOnly: toBool(existing.contentOnly, false),
    isEnabled: toBool(existing.enabled, true),
  }

  if (dcId != null) {
    const res = await client.post(DATA_CENTER_EDIT_PATH, {
      dc_id: dcId,
      name: fields.name,
      is_content: String(fields.isContentOnly),
      is_enabled: String(fields.isEnabled),
    })
    const json = parseJson<ImpervaEnvelope>(res.body)
    if (!res.ok || !isApiSuccess(json)) throw new Error(`edit data center "${fields.name}" (site ${fields.siteId}) → HTTP ${res.status}: ${apiMessage(json)}`)
  }

  const liveServers = existing.servers ?? []
  const servers: PriorServerEntry[] = []

  for (const server of fields.servers) {
    const match = findServer(liveServers, server.address)
    if (match && match.id != null) {
      const prior = { address: String(match.address ?? server.address), isStandby: toBool(match.isStandBy, false), isEnabled: toBool(match.enabled, true) }
      if (prior.isStandby !== server.isStandby || prior.isEnabled !== server.isEnabled) {
        await editServer(client, match.id, server)
      }
      servers.push({ address: server.address, serverId: match.id, prior })
    } else if (dcId != null) {
      const serverId = await addServer(client, dcId, server)
      servers.push({ address: server.address, serverId, prior: null })
    }
  }

  const declaredAddresses = new Set(fields.servers.map((s) => s.address.toLowerCase()))
  for (const live of liveServers) {
    const address = String(live.address ?? '').trim()
    if (!address || declaredAddresses.has(address.toLowerCase()) || live.id == null) continue
    await deleteServer(client, live.id)
    servers.push({ address, serverId: null, prior: { address, isStandby: toBool(live.isStandBy, false), isEnabled: toBool(live.enabled, true) } })
  }

  return { siteId: fields.siteId, name: fields.name, dcId, createdDc: false, priorDc, servers }
}

async function addServer(client: ImpervaClient, dcId: string | number, server: ServerFields): Promise<string | number | null> {
  const res = await client.post(DATA_CENTER_SERVER_ADD_PATH, {
    dc_id: dcId,
    server_address: server.address,
    is_standby: String(server.isStandby),
    is_disabled: String(!server.isEnabled), // servers/add takes is_disabled (inverted), not is_enabled
  })
  const json = parseJson<{ res?: number | string; server_id?: string }>(res.body)
  if (!res.ok || !isApiSuccess(json as ImpervaEnvelope)) {
    throw new Error(`add server "${server.address}" (dc ${dcId}) → HTTP ${res.status}: ${apiMessage(json as ImpervaEnvelope)}`)
  }
  return json?.server_id ?? null
}

async function editServer(client: ImpervaClient, serverId: string | number, server: ServerFields): Promise<void> {
  const res = await client.post(DATA_CENTER_SERVER_EDIT_PATH, {
    server_id: serverId,
    server_address: server.address,
    is_standby: String(server.isStandby),
    is_enabled: String(server.isEnabled), // servers/edit takes is_enabled directly (not inverted)
  })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) throw new Error(`edit server "${server.address}" (id ${serverId}) → HTTP ${res.status}: ${apiMessage(json)}`)
}

async function deleteServer(client: ImpervaClient, serverId: string | number): Promise<void> {
  const res = await client.post(DATA_CENTER_SERVER_DELETE_PATH, { server_id: serverId })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) throw new Error(`delete server (id ${serverId}) → HTTP ${res.status}: ${apiMessage(json)}`)
}
