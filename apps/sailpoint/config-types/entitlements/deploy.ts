import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildIscClient,
  iscErrorMessage,
  parseJson,
  readIscSettings,
  resolveIscCredential,
  IscClient,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/isc'
import type { LiveSource } from '../sources/validate'
import { extractEntitlementSpecs, type EntitlementSpec, type LiveEntitlement } from './validate'

const SOURCES = '/v3/sources'
const ENTITLEMENTS = '/beta/entitlements'

export interface RollbackEntry {
  itemId?: string
  sourceName: string
  name: string
  attribute: string
  entitlementId: string
  prior: {
    name: string
    description: string
    requestable: boolean
    privileged: boolean
    ownerId: string
    segments: string[]
    lockDisplayName: boolean
    lockDescription: boolean
  }
}

function escapeFilterValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Builds the `filters` query to find an entitlement by source + name (+ optional attribute). */
export function buildEntitlementFilter(sourceId: string, name: string, attribute: string): string {
  const parts = [`source.id eq "${escapeFilterValue(sourceId)}"`, `name eq "${escapeFilterValue(name)}"`]
  if (attribute) parts.push(`attribute eq "${escapeFilterValue(attribute)}"`)
  return parts.join(' and ')
}

function snapshot(live: LiveEntitlement): RollbackEntry['prior'] {
  return {
    name: live.name ?? '',
    description: (live.description ?? '') as string,
    requestable: live.requestable ?? false,
    privileged: live.privileged ?? false,
    ownerId: live.owner?.id ?? '',
    segments: live.segments ?? [],
    lockDisplayName: live.manuallyUpdatedFields?.DISPLAY_NAME ?? false,
    lockDescription: live.manuallyUpdatedFields?.DESCRIPTION ?? false,
  }
}

/** JSON-Patch ops bringing an entitlement to the desired governance state. Owner is only
 *  touched when declared — this app never clears an owner nobody asked it to manage. */
export function patchOps(spec: EntitlementSpec): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [
    { op: 'replace', path: '/name', value: spec.name },
    { op: 'replace', path: '/description', value: spec.description },
    { op: 'replace', path: '/requestable', value: spec.requestable },
    { op: 'replace', path: '/privileged', value: spec.privileged },
    { op: 'replace', path: '/segments', value: spec.segments },
    { op: 'replace', path: '/manuallyUpdatedFields', value: { DISPLAY_NAME: spec.lockDisplayName, DESCRIPTION: spec.lockDescription } },
  ]
  if (spec.ownerId) {
    ops.push({ op: 'replace', path: '/owner', value: { type: 'IDENTITY', id: spec.ownerId } })
  }
  return ops
}

/** Reverts an entitlement to a stored prior snapshot. A 404 means it's gone — nothing to revert. */
export async function revertEntitlement(
  client: IscClient,
  entitlementId: string,
  prior: RollbackEntry['prior']
): Promise<{ ok: boolean; error?: string }> {
  const ops: Array<Record<string, unknown>> = [
    { op: 'replace', path: '/name', value: prior.name },
    { op: 'replace', path: '/description', value: prior.description },
    { op: 'replace', path: '/requestable', value: prior.requestable },
    { op: 'replace', path: '/privileged', value: prior.privileged },
    { op: 'replace', path: '/segments', value: prior.segments },
    { op: 'replace', path: '/manuallyUpdatedFields', value: { DISPLAY_NAME: prior.lockDisplayName, DESCRIPTION: prior.lockDescription } },
  ]
  if (prior.ownerId) {
    ops.push({ op: 'replace', path: '/owner', value: { type: 'IDENTITY', id: prior.ownerId } })
  }
  const resp = await client.patch(`${ENTITLEMENTS}/${entitlementId}`, ops)
  return resp.ok || resp.status === 404 ? { ok: true } : { ok: false, error: iscErrorMessage(resp) }
}

/** Resolves the live entitlement for a spec: prefers the cached id from a prior deploy
 *  (verified still on the same source), else looks it up by source + name (+ attribute). */
async function resolveLiveEntitlement(
  client: IscClient,
  sourceId: string,
  spec: EntitlementSpec,
  cachedId?: string
): Promise<{ ok: true; live: LiveEntitlement } | { ok: false; error: string }> {
  if (cachedId) {
    const cur = await client.get(`${ENTITLEMENTS}/${cachedId}`)
    if (cur.ok) {
      const live = parseJson<LiveEntitlement>(cur.body)
      if (live?.source?.id === sourceId) return { ok: true, live }
    }
    // Cached id is stale (renamed away/removed on a different source) — fall back to lookup.
  }

  const filter = buildEntitlementFilter(sourceId, spec.name, spec.attribute)
  const resp = await client.get(`${ENTITLEMENTS}?filters=${encodeURIComponent(filter)}&limit=2`)
  if (!resp.ok) return { ok: false, error: iscErrorMessage(resp) }
  const matches = parseJson<LiveEntitlement[]>(resp.body) ?? []
  if (matches.length === 0) {
    return {
      ok: false,
      error: 'no matching entitlement found on this source — entitlements must be discovered via source aggregation before they can be managed here',
    }
  }
  if (matches.length > 1) {
    return { ok: false, error: 'multiple entitlements match this name on this source — set Attribute to disambiguate' }
  }
  return { ok: true, live: matches[0] }
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
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildIscClient(cred, settings)

  const specs = extractEntitlementSpecs(ctx.canvas).filter((s) => s.sourceName && s.name)

  const sourcesRes = await client.getAll<LiveSource>(SOURCES)
  if (!sourcesRes.ok) return { success: false, message: `Failed to list sources: ${iscErrorMessage(sourcesRes.lastError!)}` }
  const sourceByName = new Map(sourcesRes.items.filter((s) => s.name && s.id).map((s) => [s.name!.toLowerCase(), s]))

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const source = sourceByName.get(spec.sourceName.toLowerCase())
    if (!source?.id) {
      failures.push(`${spec.name}: source "${spec.sourceName}" not found`)
      continue
    }

    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const resolved = await resolveLiveEntitlement(client, source.id, spec, priorEntry?.entitlementId)
    if (!resolved.ok) {
      failures.push(`${spec.name}: ${resolved.error}`)
      continue
    }
    const live = resolved.live
    if (!live.id) {
      failures.push(`${spec.name}: matched entitlement is missing an id`)
      continue
    }

    const resp = await client.patch(`${ENTITLEMENTS}/${live.id}`, patchOps(spec))
    if (!resp.ok) {
      failures.push(`${spec.name}: ${iscErrorMessage(resp)}`)
      continue
    }
    entries.push({
      itemId: spec.itemId,
      sourceName: spec.sourceName,
      name: spec.name,
      attribute: spec.attribute,
      entitlementId: live.id,
      prior: snapshot(live),
    })
  }

  // Reconcile: revert entitlements this app previously overlaid but no longer declares.
  // The underlying entitlement is never created or deleted by this app, so "undeclaring"
  // reverts the overlay rather than removing anything. Kept-by-id protects a renamed
  // entitlement (same id, new name) from being reverted out from under itself.
  const compositeKey = (s: string, n: string, a: string): string => `${s.toLowerCase()}::${n.toLowerCase()}::${a.toLowerCase()}`
  const declaredKeys = new Set(specs.map((s) => compositeKey(s.sourceName, s.name, s.attribute)))
  const keptIds = new Set(entries.map((e) => e.entitlementId))
  for (const p of prior) {
    if (keptIds.has(p.entitlementId) || declaredKeys.has(compositeKey(p.sourceName, p.name, p.attribute))) continue
    const res = await revertEntitlement(client, p.entitlementId, p.prior)
    if (!res.ok) failures.push(`revert ${p.name}: ${res.error}`)
  }

  if (failures.length) {
    return { success: false, message: `Some entitlements failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Applied ${entries.length} entitlement overlay(s)`, rollbackData: { entries } }
}
