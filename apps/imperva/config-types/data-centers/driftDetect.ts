import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildImpervaClient, DATA_CENTER_LIST_PATH, isApiSuccess, parseJson, type ImpervaEnvelope } from '../../lib/impervaApi'
import { dataCentersFromResponse, findDataCenter, findServer, readDataCenterFields, toBool, type DataCenterStatus } from './_shared'

/**
 * Drift for data centers: compare the declared pool-level fields + server list
 * against the live data center in Imperva (matched by name within its site).
 * Best-effort — a data center that can't be matched (missing / transient error)
 * is skipped rather than raising false drift. Read-only: POST
 * /sites/dataCenters/list per distinct site.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildImpervaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const dcsBySite = new Map<string, DataCenterStatus[]>()
  const loadDcs = async (siteId: string): Promise<DataCenterStatus[] | null> => {
    if (dcsBySite.has(siteId)) return dcsBySite.get(siteId) ?? null
    try {
      const res = await client.post(DATA_CENTER_LIST_PATH, { site_id: siteId })
      const json = parseJson<ImpervaEnvelope>(res.body)
      if (!res.ok || !isApiSuccess(json)) return null
      const dcs = dataCentersFromResponse(json)
      dcsBySite.set(siteId, dcs)
      return dcs
    } catch {
      return null
    }
  }

  for (const item of items) {
    const fields = readDataCenterFields(item.fields)
    if (!fields.siteId || !fields.name) continue

    const dcs = await loadDcs(fields.siteId)
    if (!dcs) continue
    const match = findDataCenter(dcs, fields.name)
    if (!match) continue

    const label = `${fields.name} (site ${fields.siteId})`

    const liveContentOnly = toBool(match.contentOnly, false)
    if (liveContentOnly !== fields.isContentOnly) {
      diffs.push({ field: `${label}.isContentOnly`, expected: String(fields.isContentOnly), actual: String(liveContentOnly), severity: 'warning' })
    }
    const liveEnabled = toBool(match.enabled, true)
    if (liveEnabled !== fields.isEnabled) {
      diffs.push({ field: `${label}.isEnabled`, expected: String(fields.isEnabled), actual: String(liveEnabled), severity: 'warning' })
    }

    const liveServers = match.servers ?? []
    for (const server of fields.servers) {
      const liveServer = findServer(liveServers, server.address)
      if (!liveServer) {
        diffs.push({ field: `${label}.servers[${server.address}]`, expected: 'present', actual: 'missing', severity: 'warning' })
        continue
      }
      const liveStandby = toBool(liveServer.isStandBy, false)
      if (liveStandby !== server.isStandby) {
        diffs.push({ field: `${label}.servers[${server.address}].isStandby`, expected: String(server.isStandby), actual: String(liveStandby), severity: 'warning' })
      }
      const liveServerEnabled = toBool(liveServer.enabled, true)
      if (liveServerEnabled !== server.isEnabled) {
        diffs.push({ field: `${label}.servers[${server.address}].isEnabled`, expected: String(server.isEnabled), actual: String(liveServerEnabled), severity: 'warning' })
      }
    }

    const declaredAddresses = new Set(fields.servers.map((s) => s.address.toLowerCase()))
    for (const liveServer of liveServers) {
      const address = String(liveServer.address ?? '').trim()
      if (address && !declaredAddresses.has(address.toLowerCase())) {
        diffs.push({ field: `${label}.servers[${address}]`, expected: 'absent', actual: 'present (undeclared)', severity: 'info' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
