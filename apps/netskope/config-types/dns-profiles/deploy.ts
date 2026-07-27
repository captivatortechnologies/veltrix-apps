import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildNetskopeClient,
  extractProfileObject,
  netskopeErrorMessage,
  readNetskopeSettings,
  resolveNetskopeCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type NetskopeClient,
} from '../../lib/netskope'
import { extractDnsProfileSpecs, liveDnsProfileId, parseConfigBlob, type DnsProfileSpec, type LiveDnsProfile } from './validate'

const BASE = '/profiles/dns'
const MIGRATION_RETRY_DELAY_MS = 1_000

export interface DnsProfileSnapshot {
  name: string
  description: string
  log_traffic: string
  domain_config?: Record<string, unknown>
  tunnel_config?: Record<string, unknown>
  custom_config?: Record<string, unknown>
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  prior?: DnsProfileSnapshot
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function dnsProfileBody(spec: DnsProfileSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    log_traffic: spec.logTraffic,
  }
  const dc = parseConfigBlob(spec.domainConfigRaw)
  if (dc.value) body.domain_config = dc.value
  const tc = parseConfigBlob(spec.tunnelConfigRaw)
  if (tc.value) body.tunnel_config = tc.value
  const cc = parseConfigBlob(spec.customConfigRaw)
  if (cc.value) body.custom_config = cc.value
  return body
}

function snapshotLive(live: LiveDnsProfile): DnsProfileSnapshot {
  const snap: DnsProfileSnapshot = {
    name: live.name ?? '',
    description: live.description ?? '',
    log_traffic: live.log_traffic ?? 'Blocked DNS',
  }
  if (live.domain_config) snap.domain_config = live.domain_config
  if (live.tunnel_config) snap.tunnel_config = live.tunnel_config
  if (live.custom_config) snap.custom_config = live.custom_config
  return snap
}

/** DNS profile listing can 400 with "migration in progress" on the first call;
 *  retry once. */
async function listProfiles(client: NetskopeClient): Promise<{ ok: boolean; items: LiveDnsProfile[]; error?: string }> {
  let res = await client.getAll<LiveDnsProfile>(BASE)
  if (!res.ok && res.lastError && /migration/i.test(netskopeErrorMessage(res.lastError))) {
    await sleep(MIGRATION_RETRY_DELAY_MS)
    res = await client.getAll<LiveDnsProfile>(BASE)
  }
  return { ok: res.ok, items: res.items, error: res.lastError ? netskopeErrorMessage(res.lastError) : undefined }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractDnsProfileSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await listProfiles(client)
  if (!listed.ok) return { success: false, message: `Failed to list DNS profiles: ${listed.error}` }
  const liveByName = new Map<string, LiveDnsProfile>()
  const liveById = new Map<string, LiveDnsProfile>()
  for (const p of listed.items) {
    if (p.name) liveByName.set(p.name.toLowerCase(), p)
    const id = liveDnsProfileId(p)
    if (id) liveById.set(id, p)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? liveDnsProfileId(live) : undefined

    if (liveId) {
      const resp = await client.patch(`${BASE}/${liveId}`, dnsProfileBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveId, prior: snapshotLive(live!) })
    } else {
      const resp = await client.post(BASE, dnsProfileBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${netskopeErrorMessage(resp)}`)
        continue
      }
      const created = extractProfileObject<LiveDnsProfile>(resp.body)
      const newId = created ? liveDnsProfileId(created) : undefined
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: newId })
    }
  }

  // Reconcile: delete DNS profiles THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${netskopeErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some DNS profiles failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} DNS profile(s)`, rollbackData: { entries } }
}
