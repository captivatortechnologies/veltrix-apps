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
import { extractForwarderSpecs, type ForwarderSpec, type LiveForwarder } from './validate'

// A forwarder's id is a server-assigned UUID, so identity is the displayName we
// own. Forwarder config round-trips (no masked secrets), so rollback restores the
// prior config in full.
export interface RollbackEntry {
  itemId?: string
  displayName: string
  /** Whether the forwarder existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** The server-assigned forwarderId, kept so rollback/reconcile can target it after a rename. */
  forwarderId?: string
  prior?: { displayName: string; config: Record<string, unknown> }
}

const enc = encodeURIComponent

/** The server-assigned forwarderId at the tail of a `{parent}/forwarders/{id}` name. */
export function forwarderIdOf(name: string): string {
  return name.split('/').pop() ?? ''
}

export function forwarderBody(spec: ForwarderSpec): Record<string, unknown> {
  return { displayName: spec.displayName, config: spec.config ?? {} }
}

/** List every forwarder under the parent, following pagination. */
export async function listForwarders(client: SecOpsClient, parent: string): Promise<{ ok: boolean; forwarders: LiveForwarder[]; error?: string }> {
  const forwarders: LiveForwarder[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/forwarders${query}`)
    if (!res.ok) return { ok: false, forwarders, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ forwarders?: LiveForwarder[]; nextPageToken?: string }>(res.body)
    if (parsed?.forwarders) forwarders.push(...parsed.forwarders)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, forwarders }
}

/** Resolve a forwarder by displayName (used by the collectors child type). */
export function resolveForwarder(forwarders: LiveForwarder[], displayName: string): LiveForwarder | undefined {
  return forwarders.find((f) => (f.displayName ?? '') === displayName)
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

  const specs = extractForwarderSpecs(ctx.canvas).filter((s) => s.displayName)
  const prior = await loadPriorEntries(ctx)

  const listed = await listForwarders(client, parent)
  if (!listed.ok) return { success: false, message: `Could not list Google SecOps forwarders: ${listed.error}` }
  const byForwarderId = new Map(listed.forwarders.map((fw) => [forwarderIdOf(fw.name ?? ''), fw]))
  const byDisplayName = new Map(listed.forwarders.map((fw) => [fw.displayName ?? '', fw]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live = (priorEntry?.forwarderId ? byForwarderId.get(priorEntry.forwarderId) : undefined) ?? byDisplayName.get(spec.displayName)

    if (live) {
      const forwarderId = forwarderIdOf(live.name ?? '')
      const priorConfig = (live.config ?? {}) as Record<string, unknown>
      const resp = await client.request('PATCH', `${parent}/forwarders/${enc(forwarderId)}?updateMask=displayName,config`, forwarderBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: true, forwarderId, prior: { displayName: live.displayName ?? spec.displayName, config: priorConfig } })
    } else {
      const resp = await client.request('POST', `${parent}/forwarders`, forwarderBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveForwarder>(resp.body)
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: false, forwarderId: forwarderIdOf(created?.name ?? '') })
    }
  }

  // Reconcile: delete forwarders THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.displayName.toLowerCase()))
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean))
  for (const p of prior) {
    if (p.existed || !p.forwarderId) continue
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredNames.has(p.displayName.toLowerCase())) continue
    const del = await client.request('DELETE', `${parent}/forwarders/${enc(p.forwarderId)}`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${p.displayName}: ${secopsErrorMessage(del)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some forwarders failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} forwarder(s)`, rollbackData: { entries } }
}
