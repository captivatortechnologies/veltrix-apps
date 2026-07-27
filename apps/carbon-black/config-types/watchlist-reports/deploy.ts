import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/carbonblack'
import { extractReportSpecs, type ReportSpec, type LiveReport } from './validate'

// The shared watchlist reports store (watchlistmgr/v3/reports) has NO list-all
// endpoint and the server assigns each report id, so this type reconciles by the
// stored report id per canvas item (rename-safe) rather than by a live title
// listing. The app only manages reports it created; there is no way to discover
// or adopt a pre-existing external report.

export interface RollbackEntry {
  itemId?: string
  title: string
  reportId?: string
  existed: boolean
  /** prior report snapshot so rollback can restore an overwritten report. */
  prior?: LiveReport
}

function slug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** The create/update body for a shared report. `id` is set only for updates. */
export function buildReport(spec: ReportSpec, timestampSec: number, reportId?: string): Record<string, unknown> {
  const iocId = `${slug(spec.itemId || spec.title) || 'ioc'}-iocs`
  return {
    ...(reportId ? { id: reportId } : {}),
    title: spec.title,
    description: spec.description,
    severity: spec.severity,
    timestamp: timestampSec,
    ...(spec.link ? { link: spec.link } : {}),
    ...(spec.tags.length ? { tags: spec.tags } : {}),
    iocs_v2: [{ id: iocId, match_type: 'equality', field: spec.iocField, values: spec.values }],
  }
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
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildCbClient(cred, settings)
  const base = client.watchlistReportsPath()
  const ts = Math.floor(Date.now() / 1000)

  const specs = extractReportSpecs(ctx.canvas).filter((s) => s.title && s.values.length)

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map<string, RollbackEntry>()
  for (const p of prior) if (p.itemId) priorByItem.set(p.itemId, p)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const existingId = priorEntry?.reportId

    if (existingId) {
      // Fetch the current report (for the rollback snapshot) then overwrite it.
      const getRes = await client.get(`${base}/${existingId}`)
      if (getRes.ok) {
        const priorSnap = parseJson<LiveReport>(getRes.body) ?? undefined
        const updated = await client.put(`${base}/${existingId}`, buildReport(spec, ts, existingId))
        if (!updated.ok) {
          failures.push(`${spec.title}: ${cbErrorMessage(updated)}`)
          continue
        }
        entries.push({ itemId: spec.itemId, title: spec.title, reportId: existingId, existed: priorEntry!.existed, prior: priorEntry!.prior ?? priorSnap })
        continue
      }
      // The stored report is gone (deleted out-of-band) — recreate it below.
    }

    const resp = await client.post(base, buildReport(spec, ts))
    if (!resp.ok) {
      failures.push(`${spec.title}: ${cbErrorMessage(resp)}`)
      continue
    }
    const created = parseJson<LiveReport>(resp.body)
    entries.push({ itemId: spec.itemId, title: spec.title, reportId: created?.id, existed: false })
  }

  // Reconcile: delete reports THIS app created previously but no longer declares.
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean) as string[])
  const keptIds = new Set(entries.map((e) => e.reportId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.reportId && !keptIds.has(p.reportId) && !(p.itemId && declaredItems.has(p.itemId))) {
      const del = await client.delete(`${base}/${p.reportId}`)
      if (!del.ok && del.status !== 404) failures.push(`delete ${p.title}: ${cbErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some watchlist reports failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} watchlist report(s)`, rollbackData: { entries } }
}
