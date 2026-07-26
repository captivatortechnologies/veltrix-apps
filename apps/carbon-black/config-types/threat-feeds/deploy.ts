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
import { extractFeedSpecs, type FeedSpec, type LiveFeed } from './validate'

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: string
  /** prior feedinfo + reports so rollback can restore an updated feed. */
  prior?: { feedinfo: Record<string, unknown>; reports: unknown[] }
}

/** The managed report holding all the declared IOC values. */
export function buildReport(spec: FeedSpec, timestampSec: number): Record<string, unknown> {
  return {
    id: 'veltrix-managed-report',
    timestamp: timestampSec,
    title: `${spec.name} — managed IOCs`,
    description: spec.summary,
    severity: 5,
    iocs_v2: spec.values.length ? [{ id: 'veltrix-iocs', match_type: 'equality', field: spec.iocField, values: spec.values }] : [],
  }
}

export function feedinfoBody(spec: FeedSpec): Record<string, unknown> {
  return { name: spec.name, provider_url: spec.providerUrl, summary: spec.summary, category: spec.category, alertable: true }
}

async function listFeeds(client: CbClient, feedsPath: string): Promise<{ ok: boolean; items: LiveFeed[]; err?: string }> {
  const res = await client.get(feedsPath)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ results?: LiveFeed[] } | LiveFeed[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  return { ok: true, items }
}

async function getFeed(client: CbClient, feedsPath: string, id: string): Promise<{ feedinfo: Record<string, unknown>; reports: unknown[] }> {
  const res = await client.get(`${feedsPath}/${id}`)
  const parsed = parseJson<{ feedinfo?: Record<string, unknown>; reports?: unknown[] }>(res.body)
  return { feedinfo: parsed?.feedinfo ?? {}, reports: parsed?.reports ?? [] }
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

  const specs = extractFeedSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await listFeeds(client, feedsPath)
  if (!listed.ok) return { success: false, message: `Failed to list feeds: ${listed.err}` }
  const liveByName = new Map<string, LiveFeed>()
  for (const f of listed.items) if (f.name) liveByName.set(f.name.toLowerCase(), f)

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase()) ?? null
    if (live?.id) {
      const priorState = await getFeed(client, feedsPath, live.id)
      // Feed metadata is updated with a PUT on /feedinfo.
      const updated = await client.put(`${feedsPath}/${live.id}/feedinfo`, feedinfoBody(spec))
      if (!updated.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(updated)}`)
        continue
      }
      const repResp = await client.post(`${feedsPath}/${live.id}/reports`, { reports: [buildReport(spec, ts)] })
      if (!repResp.ok) {
        failures.push(`${spec.name}: reports: ${cbErrorMessage(repResp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: live.id, prior: priorState })
    } else {
      const resp = await client.post(feedsPath, { feedinfo: feedinfoBody(spec), reports: [buildReport(spec, ts)] })
      if (!resp.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveFeed>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete feeds THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${feedsPath}/${p.id}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${cbErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some feeds failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} threat feed(s)`, rollbackData: { entries } }
}
