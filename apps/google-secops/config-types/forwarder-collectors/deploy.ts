import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
  type SecOpsClient,
} from '../../lib/googlesecops'
import { extractCollectorSpecs, type CollectorSpec, type LiveCollector } from './validate'
import { listForwarders, forwarderIdOf, resolveForwarder } from '../forwarders/deploy'

// A collector is nested under a forwarder resolved by its displayName (the same
// list-and-resolve approach the rule types use). Collector settings can carry
// write-only secrets (e.g. Splunk creds), so — like feeds — drift excludes them
// and rollback restores only the display name.
export interface RollbackEntry {
  itemId?: string
  forwarderName: string
  displayName: string
  /** Whether the collector existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  forwarderId?: string
  collectorId?: string
  priorDisplayName?: string
}

const enc = encodeURIComponent

export function collectorIdOf(name: string): string {
  return name.split('/').pop() ?? ''
}

export function collectorBody(spec: CollectorSpec): Record<string, unknown> {
  return { displayName: spec.displayName, config: spec.config ?? {} }
}

/** List every collector under one forwarder, following pagination. */
export async function listCollectors(client: SecOpsClient, parent: string, forwarderId: string): Promise<{ ok: boolean; collectors: LiveCollector[]; error?: string }> {
  const collectors: LiveCollector[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/forwarders/${enc(forwarderId)}/collectors${query}`)
    if (!res.ok) return { ok: false, collectors, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ collectors?: LiveCollector[]; nextPageToken?: string }>(res.body)
    if (parsed?.collectors) collectors.push(...parsed.collectors)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, collectors }
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
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractCollectorSpecs(ctx.canvas).filter((s) => s.forwarderName && s.displayName && s.config)
  const prior = await loadPriorEntries(ctx)

  // Resolve parent forwarders once.
  const listedFwd = await listForwarders(client, parent)
  if (!listedFwd.ok) return { success: false, message: `Could not list Google SecOps forwarders: ${listedFwd.error}` }

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))
  // Cache the collector listing per resolved forwarder so we list each once.
  const collectorsByFwd = new Map<string, LiveCollector[]>()

  for (const spec of specs) {
    const forwarder = resolveForwarder(listedFwd.forwarders, spec.forwarderName)
    if (!forwarder) {
      failures.push(`${spec.displayName}: no forwarder named "${spec.forwarderName}" — declare it with the Forwarders config type first`)
      continue
    }
    const forwarderId = forwarderIdOf(forwarder.name ?? '')

    if (!collectorsByFwd.has(forwarderId)) {
      const listed = await listCollectors(client, parent, forwarderId)
      if (!listed.ok) {
        failures.push(`${spec.displayName}: could not list collectors on "${spec.forwarderName}": ${listed.error}`)
        continue
      }
      collectorsByFwd.set(forwarderId, listed.collectors)
    }
    const collectors = collectorsByFwd.get(forwarderId)!
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live =
      (priorEntry?.collectorId ? collectors.find((c) => collectorIdOf(c.name ?? '') === priorEntry.collectorId) : undefined) ??
      collectors.find((c) => (c.displayName ?? '') === spec.displayName)

    if (live) {
      const collectorId = collectorIdOf(live.name ?? '')
      const resp = await client.request('PATCH', `${parent}/forwarders/${enc(forwarderId)}/collectors/${enc(collectorId)}?updateMask=displayName,config`, collectorBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, forwarderName: spec.forwarderName, displayName: spec.displayName, existed: true, forwarderId, collectorId, priorDisplayName: live.displayName ?? spec.displayName })
    } else {
      const resp = await client.request('POST', `${parent}/forwarders/${enc(forwarderId)}/collectors`, collectorBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveCollector>(resp.body)
      entries.push({ itemId: spec.itemId, forwarderName: spec.forwarderName, displayName: spec.displayName, existed: false, forwarderId, collectorId: collectorIdOf(created?.name ?? '') })
    }
  }

  // Reconcile: delete collectors THIS app created previously but no longer declares.
  // (A deleted parent forwarder cascades, so a 404 is fine.)
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredKeys = new Set(specs.map((s) => `${s.forwarderName.toLowerCase()} ${s.displayName.toLowerCase()}`))
  for (const p of prior) {
    if (p.existed || !p.forwarderId || !p.collectorId) continue
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredKeys.has(`${p.forwarderName.toLowerCase()} ${p.displayName.toLowerCase()}`)) continue
    const del = await client.request('DELETE', `${parent}/forwarders/${enc(p.forwarderId)}/collectors/${enc(p.collectorId)}`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${p.displayName}: ${secopsErrorMessage(del)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some collectors failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} collector(s)`, rollbackData: { entries } }
}
