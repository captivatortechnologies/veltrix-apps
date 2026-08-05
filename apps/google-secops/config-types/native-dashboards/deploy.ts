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
import { extractNativeDashboardSpecs, type NativeDashboardSpec, type LiveNativeDashboard, type DashboardFilter } from './validate'

// A dashboard's id is server-assigned, so identity is the displayName we own
// (the same approach as watchlists / feeds / forwarders). Only user-created
// (`type: CUSTOM`) dashboards are managed — a matched dashboard of any other
// type (CURATED / PUBLIC / PRIVATE / MARKETPLACE, all Google- or vendor-owned)
// is reported and left untouched rather than silently overwritten.
export interface RollbackEntry {
  itemId?: string
  displayName: string
  /** Whether the dashboard existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** The server-assigned dashboardId, kept so rollback/reconcile can target it after a rename. */
  dashboardId?: string
  prior?: { displayName: string; description: string; access: string; isPinned: boolean; filters: DashboardFilter[] }
}

const enc = encodeURIComponent
const UPDATE_MASK = 'displayName,description,access,dashboardUserData.isPinned,definition.filters'
/** Dashboards this app creates are always CUSTOM — the only creatable type. */
const DASHBOARD_TYPE = 'CUSTOM'

export function dashboardBody(spec: NativeDashboardSpec): Record<string, unknown> {
  return {
    displayName: spec.displayName,
    description: spec.description,
    access: spec.access,
    type: DASHBOARD_TYPE,
    dashboardUserData: { isPinned: spec.isPinned },
    definition: { filters: spec.filters ?? [] },
  }
}

/** The server-assigned dashboardId at the tail of a `{parent}/nativeDashboards/{id}` name. */
export function dashboardIdOf(name: string): string {
  return name.split('/').pop() ?? ''
}

/** List every native dashboard under the parent, following pagination. */
export async function listDashboards(client: SecOpsClient, parent: string): Promise<{ ok: boolean; dashboards: LiveNativeDashboard[]; error?: string }> {
  const dashboards: LiveNativeDashboard[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/nativeDashboards${query}`)
    if (!res.ok) return { ok: false, dashboards, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ nativeDashboards?: LiveNativeDashboard[]; nextPageToken?: string }>(res.body)
    if (parsed?.nativeDashboards) dashboards.push(...parsed.nativeDashboards)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, dashboards }
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

  const specs = extractNativeDashboardSpecs(ctx.canvas).filter((s) => s.displayName && s.filters !== null)
  const prior = await loadPriorEntries(ctx)

  const listed = await listDashboards(client, parent)
  if (!listed.ok) return { success: false, message: `Could not list Google SecOps native dashboards: ${listed.error}` }
  const byDashboardId = new Map(listed.dashboards.map((d) => [dashboardIdOf(d.name ?? ''), d]))
  const byDisplayName = new Map(listed.dashboards.map((d) => [d.displayName ?? '', d]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live = (priorEntry?.dashboardId ? byDashboardId.get(priorEntry.dashboardId) : undefined) ?? byDisplayName.get(spec.displayName)

    if (live) {
      if (live.type && live.type !== DASHBOARD_TYPE) {
        failures.push(`${spec.displayName}: existing dashboard is type "${live.type}" (Google/vendor-owned) — only CUSTOM dashboards are managed`)
        continue
      }
      const dashboardId = dashboardIdOf(live.name ?? '')
      const priorState = {
        displayName: live.displayName ?? spec.displayName,
        description: live.description ?? '',
        access: live.access ?? 'DASHBOARD_PRIVATE',
        isPinned: live.dashboardUserData?.isPinned ?? false,
        filters: live.definition?.filters ?? [],
      }
      const resp = await client.request('PATCH', `${parent}/nativeDashboards/${enc(dashboardId)}?updateMask=${UPDATE_MASK}`, dashboardBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: true, dashboardId, prior: priorState })
    } else {
      const resp = await client.request('POST', `${parent}/nativeDashboards`, dashboardBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveNativeDashboard>(resp.body)
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: false, dashboardId: dashboardIdOf(created?.name ?? '') })
    }
  }

  // Reconcile: delete dashboards THIS app created but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.displayName.toLowerCase()))
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean))
  for (const p of prior) {
    if (p.existed || !p.dashboardId) continue
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredNames.has(p.displayName.toLowerCase())) continue
    const del = await client.request('DELETE', `${parent}/nativeDashboards/${enc(p.dashboardId)}`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${p.displayName}: ${secopsErrorMessage(del)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some native dashboards failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} native dashboard(s)`, rollbackData: { entries } }
}
