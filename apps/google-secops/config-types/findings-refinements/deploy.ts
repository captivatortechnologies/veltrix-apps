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
import { extractFindingsRefinementSpecs, REFINEMENT_TYPE, type FindingsRefinementSpec, type LiveFindingsRefinement } from './validate'

// Findings refinements have NO delete endpoint (like reference lists): "removal"
// is expressed as disabling + archiving the deployment. Identity is the
// displayName we own (the id is server-assigned).
export interface RollbackEntry {
  itemId?: string
  displayName: string
  /** Whether the refinement existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** The server-assigned id, kept so rollback/reconcile can target it after a rename. */
  refinementId?: string
  prior?: { displayName: string; query: string; outcomeFilters: unknown }
}

const enc = encodeURIComponent

/** The server-assigned id at the tail of a `{parent}/findingsRefinements/{id}` name. */
export function refinementIdOf(name: string): string {
  return name.split('/').pop() ?? ''
}

export function refinementBody(spec: FindingsRefinementSpec): Record<string, unknown> {
  return { displayName: spec.displayName, type: REFINEMENT_TYPE, query: spec.query, outcomeFilters: spec.outcomeFilters ?? [] }
}

/** List every findings refinement under the parent, following pagination. */
export async function listRefinements(client: SecOpsClient, parent: string): Promise<{ ok: boolean; refinements: LiveFindingsRefinement[]; error?: string }> {
  const refinements: LiveFindingsRefinement[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/findingsRefinements${query}`)
    if (!res.ok) return { ok: false, refinements, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ findingsRefinements?: LiveFindingsRefinement[]; nextPageToken?: string }>(res.body)
    if (parsed?.findingsRefinements) refinements.push(...parsed.findingsRefinements)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, refinements }
}

/** Disable + archive a refinement's deployment — the "delete" for this no-delete resource. */
async function disableDeployment(client: SecOpsClient, parent: string, id: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const res = await client.request('PATCH', `${parent}/findingsRefinements/${enc(id)}/deployment?updateMask=enabled,archived`, { enabled: false, archived: true })
  return { ok: res.ok, status: res.status, error: res.ok ? undefined : secopsErrorMessage(res) }
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

  const specs = extractFindingsRefinementSpecs(ctx.canvas).filter((s) => s.displayName && s.query)
  const prior = await loadPriorEntries(ctx)

  const listed = await listRefinements(client, parent)
  if (!listed.ok) return { success: false, message: `Could not list Google SecOps findings refinements: ${listed.error}` }
  const byId = new Map(listed.refinements.map((r) => [refinementIdOf(r.name ?? ''), r]))
  const byDisplayName = new Map(listed.refinements.map((r) => [r.displayName ?? '', r]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live = (priorEntry?.refinementId ? byId.get(priorEntry.refinementId) : undefined) ?? byDisplayName.get(spec.displayName)

    if (live) {
      const refinementId = refinementIdOf(live.name ?? '')
      const priorState = { displayName: live.displayName ?? spec.displayName, query: live.query ?? '', outcomeFilters: live.outcomeFilters ?? [] }
      const resp = await client.request('PATCH', `${parent}/findingsRefinements/${enc(refinementId)}?updateMask=displayName,query,outcomeFilters`, refinementBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: true, refinementId, prior: priorState })
    } else {
      const resp = await client.request('POST', `${parent}/findingsRefinements`, refinementBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveFindingsRefinement>(resp.body)
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: false, refinementId: refinementIdOf(created?.name ?? '') })
    }
  }

  // Reconcile: findings refinements cannot be deleted, so disable + archive the
  // deployment of ones this app created but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.displayName.toLowerCase()))
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean))
  for (const p of prior) {
    if (p.existed || !p.refinementId) continue
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredNames.has(p.displayName.toLowerCase())) continue
    const disabled = await disableDeployment(client, parent, p.refinementId)
    if (!disabled.ok && disabled.status !== 404) failures.push(`disable ${p.displayName}: ${disabled.error}`)
  }

  if (failures.length) {
    return { success: false, message: `Some findings refinements failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} findings refinement(s)`, rollbackData: { entries } }
}
