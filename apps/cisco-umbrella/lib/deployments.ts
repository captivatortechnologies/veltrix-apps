// =============================================================================
// Shared engine for the Umbrella Deployments API (/deployments/v2/*).
//
// Unlike the Policies v2 surface (which wraps responses in the
// { status, meta, data } envelope), the Deployments v2 endpoints return BARE
// JSON — a top-level array for a collection and a top-level object for a single
// resource. These helpers page and parse that bare shape (tolerating an
// enveloped body too, defensively) and provide a generic upsert-by-identity /
// rollback / drift engine reused by the networks, internal-domains and sites
// config types.
//
// Each deployment resource is addressed by an opaque id (originId / id / siteId),
// so — like Destination Lists — a declared item is matched to a live one by its
// IDENTITY field and the resource id is stored after deploy for rename-safety.
// Reconcile only deletes resources THIS app created.
//
// NOTE: paths + shapes follow the Cisco Umbrella API (Cloud Security) Deployments
// documentation. Verify against a live Umbrella tenant.
// =============================================================================

import type {
  ConfigStatus,
  DeployContext,
  DeployResult,
  DriftContext,
  DriftResult,
  HealthCheckContext,
  HealthCheckResult,
  PipelineContext,
  RollbackContext,
  RollbackResult,
} from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient, PAGE_LIMIT, parseJson, umbrellaErrorMessage } from './umbrellaApi'
import type { UmbrellaClient } from './umbrellaApi'

export const DEPLOYMENTS_NETWORKS_PATH = '/deployments/v2/networks'
export const DEPLOYMENTS_INTERNAL_DOMAINS_PATH = '/deployments/v2/internaldomains'
export const DEPLOYMENTS_SITES_PATH = '/deployments/v2/sites'

/** A live Deployments resource is a bare JSON object of unknown fields. */
export type LiveResource = Record<string, unknown>

/** Parse a Deployments collection body — a bare array (or an enveloped one). */
export function arrayOf<T>(body: string): T[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as T[]
  const data = (parsed as { data?: unknown } | null)?.data
  return Array.isArray(data) ? (data as T[]) : []
}

/** Parse a single Deployments resource body — a bare object (or an enveloped one). */
export function objectOf<T>(body: string): T | null {
  const parsed = parseJson<unknown>(body)
  if (!parsed || typeof parsed !== 'object') return null
  const data = (parsed as { data?: unknown }).data
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as T
  return parsed as T
}

/**
 * GET a bare-array Deployments collection, paging via page/limit until a short
 * page. Returns every row or the first failing response.
 */
export async function listDeployment<T = LiveResource>(
  client: UmbrellaClient,
  path: string,
  maxPages = 100,
): Promise<{ ok: boolean; items: T[]; lastError?: string }> {
  const items: T[] = []
  for (let page = 1; page <= maxPages; page++) {
    const res = await client.get(path, { page, limit: PAGE_LIMIT })
    if (!res.ok) return { ok: false, items, lastError: umbrellaErrorMessage(res) }
    const rows = arrayOf<T>(res.body)
    items.push(...rows)
    if (rows.length < PAGE_LIMIT) break
  }
  return { ok: true, items }
}

/**
 * Descriptor a config type provides to drive the generic deploy/rollback/drift
 * engine. `body` builds the create/update payload from a declared spec;
 * `bodyFromLive` reconstructs the equivalent payload from a live resource (for
 * capturing a prior state to restore on rollback and for field-level drift).
 */
export interface DeployableResource<Spec extends { itemId?: string }> {
  /** Singular human label, e.g. "network". */
  label: string
  /** Plural human label, e.g. "networks". */
  labelPlural: string
  collectionPath: string
  resourcePath: (id: string | number) => string
  /** Lowercased identity match key for a declared spec. */
  keyOfSpec: (spec: Spec) => string
  /** Lowercased identity match key for a live resource. */
  keyOfLive: (live: LiveResource) => string
  /** Display name for a declared spec (used in messages/diffs). */
  nameOfSpec: (spec: Spec) => string
  /** The opaque id used in the resource path (originId / id / siteId). */
  idOfLive: (live: LiveResource) => string | number | undefined
  /** Create/update request body from a declared spec. */
  body: (spec: Spec) => Record<string, unknown>
  /** Equivalent body reconstructed from a live resource. */
  bodyFromLive: (live: LiveResource) => Record<string, unknown>
  /** Guard: return false for resources that must never be deleted (e.g. the default site). */
  deletable?: (live: LiveResource) => boolean
}

/** One resource applied by a deploy — persisted as rollbackData for rollback/reconcile. */
export interface DeployEntry {
  itemId?: string
  key: string
  name: string
  /** Whether the resource existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  resourceId?: string | number
  /** Body captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

function normalize(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value).trim().toLowerCase()
}

async function loadPriorEntries(ctx: DeployContext): Promise<DeployEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: DeployEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as DeployEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Converge the declared specs to Umbrella: create the missing ones, update the
 * present ones (matched by stored id first for rename-safety, else by identity),
 * and reconcile away resources THIS app previously created but no longer
 * declares. Returns rollbackData.entries for rollback.
 */
export async function deployResources<Spec extends { itemId?: string }>(
  ctx: DeployContext,
  client: UmbrellaClient,
  specs: Spec[],
  desc: DeployableResource<Spec>,
): Promise<DeployResult> {
  const listed = await listDeployment(client, desc.collectionPath)
  if (!listed.ok) {
    return { success: false, message: `Failed to list ${desc.labelPlural}: ${listed.lastError}` }
  }
  const liveByKey = new Map<string, LiveResource>()
  const liveById = new Map<string, LiveResource>()
  for (const l of listed.items) {
    const key = desc.keyOfLive(l)
    if (key) liveByKey.set(key, l)
    const id = desc.idOfLive(l)
    if (id != null) liveById.set(String(id), l)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))

  const entries: DeployEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const key = desc.keyOfSpec(spec)
    const name = desc.nameOfSpec(spec)
    const priorEntry = spec.itemId ? priorByItemId.get(spec.itemId) : undefined
    const liveMatch =
      (priorEntry?.resourceId != null ? liveById.get(String(priorEntry.resourceId)) : undefined) ??
      liveByKey.get(key) ??
      null

    if (liveMatch && desc.idOfLive(liveMatch) != null) {
      const id = desc.idOfLive(liveMatch) as string | number
      const priorBody = desc.bodyFromLive(liveMatch)
      const res = await client.request('PUT', desc.resourcePath(id), { body: desc.body(spec) })
      if (!res.ok) {
        failures.push(`update ${desc.label} "${name}": ${umbrellaErrorMessage(res)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, key, name, existed: true, resourceId: id, prior: priorBody })
    } else {
      const res = await client.post(desc.collectionPath, desc.body(spec))
      if (!res.ok) {
        failures.push(`create ${desc.label} "${name}": ${umbrellaErrorMessage(res)}`)
        continue
      }
      const created = objectOf<LiveResource>(res.body)
      const id = created ? desc.idOfLive(created) : undefined
      if (id == null) {
        failures.push(`create ${desc.label} "${name}": Umbrella returned no id`)
        continue
      }
      entries.push({ itemId: spec.itemId, key, name, existed: false, resourceId: id })
    }
  }

  // Reconcile: delete resources THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map(desc.keyOfSpec))
  const keptIds = new Set(entries.map((e) => (e.resourceId != null ? String(e.resourceId) : '')).filter(Boolean))
  for (const p of prior) {
    if (p.existed || p.resourceId == null) continue
    if (keptIds.has(String(p.resourceId)) || declaredKeys.has(p.key)) continue
    const live = liveById.get(String(p.resourceId))
    if (live && desc.deletable && !desc.deletable(live)) continue
    const res = await client.delete(desc.resourcePath(p.resourceId))
    if (!res.ok && res.status !== 404) failures.push(`delete ${desc.label} "${p.name}": ${umbrellaErrorMessage(res)}`)
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some ${desc.labelPlural} failed: ${failures.join('; ')}.`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} ${desc.labelPlural}.`,
    artifacts: { applied: entries.map((e) => e.name) },
    rollbackData: { entries },
  }
}

/**
 * Undo a deploy from rollbackData.entries:
 *   created (existed false): delete the resource we created.
 *   updated (existed true):  PUT the prior body captured at deploy time.
 */
export async function rollbackResources<Spec extends { itemId?: string }>(
  ctx: RollbackContext,
  client: UmbrellaClient,
  desc: DeployableResource<Spec>,
): Promise<RollbackResult> {
  const data = ctx.rollbackData as { entries?: DeployEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  if (entries.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const failures: string[] = []
  let deleted = 0
  let restored = 0

  for (const e of entries) {
    if (e.resourceId == null) continue
    if (!e.existed) {
      const res = await client.delete(desc.resourcePath(e.resourceId))
      if (!res.ok && res.status !== 404) failures.push(`delete ${desc.label} "${e.name}": ${umbrellaErrorMessage(res)}`)
      else deleted++
    } else if (e.prior) {
      const res = await client.request('PUT', desc.resourcePath(e.resourceId), { body: e.prior })
      if (!res.ok) failures.push(`restore ${desc.label} "${e.name}": ${umbrellaErrorMessage(res)}`)
      else restored++
    }
  }

  if (failures.length) return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  return { success: true, message: `Rolled back ${desc.labelPlural}: ${deleted} deleted, ${restored} restored.` }
}

/**
 * Drift for a deployment resource: a declared resource that is absent is
 * critical drift; a present one is compared field-by-field against its declared
 * body (warnings). Best-effort and read-only.
 */
export async function driftResources<Spec extends { itemId?: string }>(
  _ctx: DriftContext,
  client: UmbrellaClient,
  specs: Spec[],
  desc: DeployableResource<Spec>,
): Promise<DriftResult> {
  const listed = await listDeployment(client, desc.collectionPath)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map(listed.items.map((l) => [desc.keyOfLive(l), l]))

  const diffs: DriftResult['diffs'] = []
  for (const spec of specs) {
    const name = desc.nameOfSpec(spec)
    const live = liveByKey.get(desc.keyOfSpec(spec))
    if (!live) {
      diffs.push({ field: name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const want = desc.body(spec)
    const have = desc.bodyFromLive(live)
    for (const field of Object.keys(want)) {
      if (normalize(want[field]) !== normalize(have[field])) {
        diffs.push({
          field: `${name}.${field}`,
          expected: want[field],
          actual: have[field] ?? null,
          severity: 'warning',
        })
      }
    }
  }
  return { hasDrift: diffs.length > 0, diffs }
}

/**
 * Health for a deployment config type = Umbrella authenticates the API key/secret
 * and answers the resource collection (read-only GET ?limit=1). Returns a
 * ready-made healthCheck handler for the given path/check name.
 */
export function deploymentHealthCheck(collectionPath: string, checkName: string) {
  return async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
    const checks: HealthCheckResult['checks'] = []
    const built = buildUmbrellaClient(ctx.credential, ctx.settings)
    if ('error' in built) {
      checks.push({ name: 'credential', passed: false, message: built.error })
      return { healthy: false, score: 0, checks }
    }

    const start = Date.now()
    try {
      const res = await built.client.get(collectionPath, { page: 1, limit: 1 })
      checks.push({
        name: checkName,
        passed: res.ok,
        message: res.ok ? `Reached the Umbrella ${checkName} API.` : `Umbrella error: ${umbrellaErrorMessage(res)}`,
        latencyMs: Date.now() - start,
      })
    } catch (err) {
      checks.push({
        name: checkName,
        passed: false,
        message: `Umbrella unreachable: ${err instanceof Error ? err.message : 'error'}`,
        latencyMs: Date.now() - start,
      })
    }

    const passed = checks.every((c) => c.passed)
    return { healthy: passed, score: passed ? 100 : 0, checks }
  }
}

/** Generic deployment status from platform records — identical across config types. */
export async function deploymentGetStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  let lastDeployedAt = ''
  let deployed = false
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    if (prev) {
      deployed = true
      lastDeployedAt = prev.completedAt ?? prev.startedAt ?? ''
    }
  } catch {
    // Best-effort — absence of a deployment record just means "not deployed yet".
  }

  const componentStatuses = ctx.component
    ? [
        {
          componentId: ctx.component.id,
          hostname: ctx.component.hostname,
          deployed,
          lastDeployedAt: lastDeployedAt || undefined,
        },
      ]
    : []

  return {
    deployed,
    version: String(ctx.canvas.version ?? ''),
    lastDeployedAt,
    componentStatuses,
  }
}
