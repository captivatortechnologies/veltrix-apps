import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from '../../lib/qradar'
import { extractDomainSpecs, type DomainSpec, type LiveDomain } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  /** the QRadar domain id, for rename-safe matching and delete/restore. */
  id?: number
  prior?: { name: string; description: string }
}

export async function listDomains(client: QRadarClient): Promise<LiveDomain[]> {
  const res = await client.request('GET', '/config/domain_management/domains', { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveDomain[]>(res.body)
  return Array.isArray(parsed) ? parsed.filter((d) => !d.deleted) : []
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

function matchLive(spec: DomainSpec, priorId: number | undefined, byId: Map<number, LiveDomain>, byName: Map<string, LiveDomain>): LiveDomain | undefined {
  if (priorId !== undefined && byId.has(priorId)) return byId.get(priorId)
  return byName.get(spec.name.toLowerCase())
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractDomainSpecs(ctx.canvas).filter((s) => s.name)
  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
  const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

  const live = await listDomains(client)
  const byId = new Map(live.filter((d) => typeof d.id === 'number').map((d) => [d.id as number, d]))
  const byName = new Map(live.filter((d) => d.name).map((d) => [String(d.name).toLowerCase(), d]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const existing = matchLive(spec, priorEntry?.id, byId, byName)

    if (existing && typeof existing.id === 'number') {
      const priorState = { name: existing.name ?? '', description: existing.description ?? '' }
      if (priorState.name !== spec.name || priorState.description !== spec.description) {
        const resp = await client.request('POST', `/config/domain_management/domains/${existing.id}`, { body: { name: spec.name, description: spec.description } })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: existing.id, prior: priorState })
    } else {
      const resp = await client.request('POST', '/config/domain_management/domains', { body: { name: spec.name, description: spec.description } })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveDomain>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete domains THIS app created previously but no longer declares.
  // "Still declared" is keyed off the specs (by itemId or name), not off this
  // run's successful entries, so a transient update failure never triggers a delete.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  for (const p of prior) {
    if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.request('DELETE', `/config/domain_management/domains/${p.id}`)
      if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some domains failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} domain(s)`, rollbackData: { entries } }
}
