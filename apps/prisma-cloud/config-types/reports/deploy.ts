import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPcClient,
  pcErrorMessage,
  parseJson,
  readPcSettings,
  resolvePcCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type PcClient,
} from '../../lib/prismacloud'
import { extractReportSpecs, type LiveReport, type ReportSpec } from './validate'

const BASE = '/report'

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the report existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  prior?: { name: string; reportType: string; cloudType: string; target: Record<string, unknown> | null }
}

export function reportBody(spec: ReportSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    reportType: spec.reportType,
    target: spec.target ?? {},
  }
  if (spec.cloudType) body.cloudType = spec.cloudType
  return body
}

function reportId(r: LiveReport): string | undefined {
  return r.id ?? r.reportId
}

async function listReports(client: PcClient): Promise<{ ok: boolean; items: LiveReport[]; err?: string }> {
  const res = await client.get(BASE)
  if (!res.ok) return { ok: false, items: [], err: pcErrorMessage(res) }
  return { ok: true, items: parseJson<LiveReport[]>(res.body) ?? [] }
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
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildPcClient(cred, settings)

  const specs = extractReportSpecs(ctx.canvas).filter((s) => s.name && s.reportType && !s.targetError && s.target)

  const listed = await listReports(client)
  if (!listed.ok) return { success: false, message: `Failed to list reports: ${listed.err}` }
  const liveByName = new Map<string, LiveReport>()
  const liveById = new Map<string, LiveReport>()
  for (const r of listed.items) {
    if (r.name) liveByName.set(r.name.toLowerCase(), r)
    const id = reportId(r)
    if (id) liveById.set(id, r)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const createdNames: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const live = (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null
    const liveId = live ? reportId(live) : undefined

    if (liveId) {
      const resp = await client.put(`${BASE}/${liveId}`, reportBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      entries.push({
        itemId: spec.itemId,
        name: spec.name,
        existed: true,
        id: liveId,
        prior: { name: live!.name ?? '', reportType: live!.reportType ?? spec.reportType, cloudType: live!.cloudType ?? '', target: live!.target ?? null },
      })
    } else {
      const resp = await client.post(BASE, reportBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${pcErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveReport>(resp.body)
      const createdId = created ? reportId(created) : undefined
      if (createdId) {
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: createdId })
      } else {
        createdNames.push(spec.name)
        entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: priorEntry?.id })
      }
    }
  }

  // Resolve ids for freshly-created reports whose create returned no id.
  if (createdNames.length) {
    const relisted = await listReports(client)
    if (relisted.ok) {
      const byName = new Map(relisted.items.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))
      for (const e of entries) {
        if (!e.existed && !e.id) e.id = reportId(byName.get(e.name.toLowerCase()) ?? {})
      }
    }
  }

  // Reconcile: delete reports THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${pcErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some reports failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} report(s)`, rollbackData: { entries } }
}
