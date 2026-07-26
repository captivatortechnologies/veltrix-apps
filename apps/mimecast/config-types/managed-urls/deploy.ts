import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildMimecastClient,
  mimecastErrorMessage,
  readMimecastSettings,
  resolveMimecastCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/mimecast'
import {
  desiredIdentity,
  extractManagedUrlSpecs,
  liveIdentity,
  normUrl,
  type LiveManagedUrl,
  type ManagedUrlSpec,
} from './validate'

const CREATE = '/api/ttp/url/create-managed-url'
const GET_ALL = '/api/ttp/url/get-all-managed-urls'
const DELETE = '/api/ttp/url/delete-managed-url'

export interface RollbackEntry {
  itemId?: string
  /** the URL identity (matchType + normalized url/domain). */
  name: string
  /** Whether an entry with this identity existed BEFORE this app first managed it. */
  existed: boolean
  /** the current Mimecast id representing this identity. */
  id?: string
  /** the original create payload, so rollback can recreate it. */
  prior?: Record<string, unknown>
}

export function buildCreatePayload(spec: ManagedUrlSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = { url: spec.url, action: spec.action, matchType: spec.matchType }
  if (spec.comment) payload.comment = spec.comment
  if (spec.action === 'permit') {
    payload.disableRewrite = spec.disableRewrite
    payload.disableUserAwareness = spec.disableUserAwareness
  }
  payload.disableLogClick = spec.disableLogClick
  return payload
}

/** Reconstruct a create payload from a live entry, so rollback can recreate it. */
function reconstructUrl(entry: LiveManagedUrl): string {
  if (entry.url) return entry.url
  const scheme = entry.scheme || 'https'
  const port = entry.port && entry.port !== -1 ? `:${entry.port}` : ''
  const qs = entry.queryString ? `?${entry.queryString}` : ''
  return normUrl(`${scheme}://${entry.domain ?? ''}${port}${entry.path ?? ''}${qs}`)
}

export function snapshotLive(entry: LiveManagedUrl): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    url: reconstructUrl(entry),
    action: entry.action ?? 'block',
    matchType: entry.matchType ?? 'explicit',
  }
  if (entry.comment) payload.comment = entry.comment
  if ((entry.action ?? '') === 'permit') {
    payload.disableRewrite = entry.disableRewrite ?? false
    payload.disableUserAwareness = entry.disableUserAwareness ?? false
  }
  payload.disableLogClick = entry.disableLogClick ?? false
  return payload
}

/** Whether a live entry already equals the desired spec (identity matches). */
export function definitionEquals(entry: LiveManagedUrl, spec: ManagedUrlSpec): boolean {
  if ((entry.action ?? '') !== spec.action) return false
  if ((entry.comment ?? '') !== spec.comment) return false
  if (spec.action === 'permit') {
    if ((entry.disableRewrite ?? false) !== spec.disableRewrite) return false
    if ((entry.disableUserAwareness ?? false) !== spec.disableUserAwareness) return false
  }
  return (entry.disableLogClick ?? false) === spec.disableLogClick
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
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildMimecastClient(cred, settings)

  const specs = extractManagedUrlSpecs(ctx.canvas).filter((s) => s.url)

  const listed = await client.request(GET_ALL, {})
  if (!listed.ok) return { success: false, message: `Failed to list managed URLs: ${mimecastErrorMessage(listed)}` }
  const liveEntries = listed.data as LiveManagedUrl[]
  const liveByKey = new Map<string, LiveManagedUrl>()
  for (const e of liveEntries) liveByKey.set(liveIdentity(e), e)

  const prior = await loadPriorEntries(ctx)
  const priorByKey = new Map(prior.map((e) => [e.name, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = desiredIdentity(spec)
    const live = liveByKey.get(key) ?? null
    const priorEntry = priorByKey.get(key)

    let existed: boolean
    let priorSnap: Record<string, unknown> | undefined
    if (priorEntry) {
      existed = priorEntry.existed
      priorSnap = priorEntry.prior
    } else if (live) {
      existed = true
      priorSnap = snapshotLive(live)
    } else {
      existed = false
      priorSnap = undefined
    }

    if (live?.id && definitionEquals(live, spec)) {
      entries.push({ itemId: spec.itemId, name: key, existed, id: live.id, prior: priorSnap })
      continue
    }

    // No update API — delete the old one (if any) and create the desired.
    if (live?.id) {
      const del = await client.request(DELETE, { id: live.id })
      if (!del.ok) {
        failures.push(`${spec.url}: ${mimecastErrorMessage(del)}`)
        continue
      }
    }
    const resp = await client.request(CREATE, buildCreatePayload(spec))
    if (!resp.ok) {
      failures.push(`${spec.url}: ${mimecastErrorMessage(resp)}`)
      continue
    }
    const created = resp.data[0] as LiveManagedUrl | undefined
    entries.push({ itemId: spec.itemId, name: key, existed, id: created?.id, prior: priorSnap })
  }

  // Reconcile: delete managed URLs THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => desiredIdentity(s)))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredKeys.has(p.name)) {
      const del = await client.request(DELETE, { id: p.id })
      if (!del.ok) failures.push(`delete ${p.name}: ${mimecastErrorMessage(del)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some managed URLs failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} managed URL(s)`, rollbackData: { entries } }
}
