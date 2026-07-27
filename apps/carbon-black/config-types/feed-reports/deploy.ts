import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type CbClient,
} from '../../lib/carbonblack'
import type { LiveFeed } from '../threat-feeds/validate'
import { extractReportSpecs, type ReportSpec, type LiveReport } from './validate'

export interface RollbackEntry {
  itemId?: string
  feedName: string
  feedId: string
  title: string
  reportId: string
  existed: boolean
  /** prior report snapshot so rollback can restore an overwritten report. */
  prior?: LiveReport
}

function slug(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** A caller-supplied report id, deterministic per canvas item. */
export function reportIdFor(spec: ReportSpec): string {
  return `veltrix-${slug(spec.itemId || spec.title) || 'report'}`
}

/** The managed report holding this spec's declared IOC values. */
export function buildReport(spec: ReportSpec, reportId: string, timestampSec: number): Record<string, unknown> {
  return {
    id: reportId,
    timestamp: timestampSec,
    title: spec.title,
    description: spec.description,
    severity: spec.severity,
    ...(spec.link ? { link: spec.link } : {}),
    iocs_v2: [{ id: `${reportId}-iocs`, match_type: 'equality', field: spec.iocField, values: spec.values }],
  }
}

async function listFeeds(client: CbClient, feedsPath: string): Promise<{ ok: boolean; items: LiveFeed[]; err?: string }> {
  const res = await client.get(feedsPath)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ results?: LiveFeed[] } | LiveFeed[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  return { ok: true, items }
}

async function listReports(client: CbClient, reportsPath: string): Promise<{ ok: boolean; items: LiveReport[]; err?: string }> {
  const res = await client.get(reportsPath)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ results?: LiveReport[] } | LiveReport[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  return { ok: true, items }
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
  const feedsPath = `/threathunter/feedmgr/v2/orgs/${cred.orgKey}/feeds`
  const ts = Math.floor(Date.now() / 1000)

  const specs = extractReportSpecs(ctx.canvas).filter((s) => s.feedName && s.title && s.values.length)

  const listedFeeds = await listFeeds(client, feedsPath)
  if (!listedFeeds.ok) return { success: false, message: `Failed to list feeds: ${listedFeeds.err}` }
  const feedByName = new Map<string, LiveFeed>()
  for (const f of listedFeeds.items) if (f.name) feedByName.set(f.name.toLowerCase(), f)

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map<string, RollbackEntry>()
  for (const p of prior) if (p.itemId) priorByItem.set(p.itemId, p)

  // Group declared reports by target feed; reports are replaced per feed.
  const byFeed = new Map<string, ReportSpec[]>()
  for (const spec of specs) {
    const key = spec.feedName.toLowerCase()
    const list = byFeed.get(key) ?? []
    list.push(spec)
    byFeed.set(key, list)
  }

  // Also visit feeds we previously wrote into, so reconcile can drop
  // app-created reports even from a feed no longer declared this deploy.
  const feedKeys = new Set<string>(byFeed.keys())
  for (const p of prior) feedKeys.add(p.feedName.toLowerCase())

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const feedKey of feedKeys) {
    const feed = feedByName.get(feedKey)
    const feedSpecs = byFeed.get(feedKey) ?? []
    const priorForFeed = prior.filter((p) => p.feedName.toLowerCase() === feedKey)

    if (!feed?.id) {
      if (feedSpecs.length) failures.push(`${feedSpecs[0].feedName}: feed not found`)
      continue
    }
    const reportsPath = `${feedsPath}/${feed.id}/reports`
    const listed = await listReports(client, reportsPath)
    if (!listed.ok) {
      failures.push(`${feed.name}: failed to list reports: ${listed.err}`)
      continue
    }

    // Start from the feed's current reports so we preserve any this app does
    // not own; upsert ours by report id, then reconcile-delete our stale ones.
    const merged = new Map<string, unknown>()
    const liveById = new Map<string, LiveReport>()
    const liveByTitle = new Map<string, LiveReport>()
    for (const r of listed.items) {
      if (!r.id) continue
      merged.set(r.id, r)
      liveById.set(r.id, r)
      if (r.title) liveByTitle.set(r.title.toLowerCase(), r)
    }

    const feedEntries: RollbackEntry[] = []
    const declaredIds = new Set<string>()

    for (const spec of feedSpecs) {
      const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
      // Prefer the prior-stored id (rename-safe); else adopt a live report
      // matched by title; else reuse the prior id; else a deterministic new id.
      let reportId = priorEntry?.reportId && liveById.has(priorEntry.reportId) ? priorEntry.reportId : undefined
      if (!reportId) reportId = liveByTitle.get(spec.title.toLowerCase())?.id
      if (!reportId) reportId = priorEntry?.reportId
      if (!reportId) reportId = reportIdFor(spec)

      const liveMatch = liveById.get(reportId)
      const existed = liveMatch ? (priorEntry ? priorEntry.existed : true) : false
      merged.set(reportId, buildReport(spec, reportId, ts))
      declaredIds.add(reportId)
      feedEntries.push({
        itemId: spec.itemId,
        feedName: spec.feedName,
        feedId: feed.id,
        title: spec.title,
        reportId,
        existed,
        prior: existed && liveMatch ? liveMatch : undefined,
      })
    }

    let removed = 0
    for (const p of priorForFeed) {
      if (!p.existed && p.reportId && !declaredIds.has(p.reportId) && merged.delete(p.reportId)) removed++
    }

    // Nothing to write for a feed that only shows up via stale prior entries.
    if (feedSpecs.length === 0 && removed === 0) continue

    const resp = await client.post(reportsPath, { reports: [...merged.values()] })
    if (!resp.ok) {
      failures.push(`${feed.name}: ${cbErrorMessage(resp)}`)
      continue
    }
    entries.push(...feedEntries)
  }

  if (failures.length) {
    return { success: false, message: `Some feed reports failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} feed report(s)`, rollbackData: { entries } }
}
