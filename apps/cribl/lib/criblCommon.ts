// =============================================================================
// Shared helpers for the Cribl system-config config types — Routes, Sources and
// Destinations. Kept separate from the pipelines config type (which has its own
// _shared) so the routing-table / inputs / outputs logic can be reused across
// the three new types without duplicating parsing, worker-group resolution,
// list-envelope unwrapping or order-insensitive comparison.
//
// The worker-group-aware REST transport (buildCriblUrl / criblConnect / getJson
// / sendJson / groupResourcePath) lives in ./criblApi and is reused verbatim.
//
// NOTE: Cribl REST shapes follow the documented API (list responses wrap rows in
// `{ items: [...], count }`; group-scoped resources live under /api/v1/m/<group>/…).
// Verify against a live Cribl.
// =============================================================================

import type {
  HealthCheckContext,
  HealthCheckResult,
  HealthCheck,
  PipelineContext,
  ConfigStatus,
  ComponentConfigStatus,
} from '@veltrixsecops/app-sdk'
import { DEFAULT_WORKER_GROUP, buildCriblUrl, criblConnect, criblRequest, apiRoot } from './criblApi'

/** Component types every Cribl config type deploys onto (a Leader or standalone). */
export const CRIBL_COMPONENT_TYPES = ['cribl-leader', 'standalone'] as const

/** Cribl object ids: letters, digits, underscore and hyphen (no spaces). */
export const CRIBL_ID_RE = /^[A-Za-z0-9_-]+$/

/**
 * Resolve the target Worker Group / Edge Fleet for an item:
 *   item field `worker_group` → settings.default_worker_group → "default".
 * An explicitly blank setting yields "" (single-instance / non-distributed).
 */
export function resolveWorkerGroup(fields: Record<string, unknown>, settings: Record<string, unknown>): string {
  const fromField = String(fields.worker_group ?? '').trim()
  if (fromField) return fromField
  const fromSetting = settings?.default_worker_group
  if (typeof fromSetting === 'string') return fromSetting.trim()
  return DEFAULT_WORKER_GROUP
}

/** Unwrap Cribl's `{ items: [...] }` list envelope (or a bare array) into rows. */
export function itemsFromList<T>(list: unknown): T[] {
  if (Array.isArray(list)) return list as T[]
  if (list && typeof list === 'object' && Array.isArray((list as { items?: unknown }).items)) {
    return (list as { items: T[] }).items
  }
  return []
}

/** Find a row by its `id` (the stable identity used to upsert / detect drift). */
export function findById<T extends { id?: string }>(rows: T[], id: string): T | null {
  const target = id.trim()
  if (!target) return null
  return rows.find((r) => String(r.id ?? '').trim() === target) ?? null
}

/** Stable, key-sorted JSON of a value — for order-insensitive drift comparison. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return null
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(sort)
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sort((v as Record<string, unknown>)[k])
        return acc
      }, {})
  }
  return JSON.stringify(sort(value))
}

/** A subset of `source` limited to `keys` — for comparing only the fields we declare. */
export function pickKeys(source: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!source) return out
  for (const k of keys) if (k in source) out[k] = source[k]
  return out
}

export interface ParsedJson<T> {
  value: T | null
  error: string | null
}

/**
 * Parse a JSON textarea into a plain object (rejects arrays and primitives).
 * Used for the `conf` block of a Source / Destination.
 */
export function parseJsonObject(raw: unknown, label = 'conf'): ParsedJson<Record<string, unknown>> {
  const text = String(raw ?? '').trim()
  if (!text) return { value: null, error: `${label} is empty — provide the configuration as JSON.` }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { value: null, error: `${label} is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: `${label} must be a JSON object.` }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

// --- Shared handler implementations ------------------------------------------
// Health and deployment status are identical for every Cribl config type (they
// probe the same REST API / read the same platform deployment record), so the
// per-type handler files are thin re-exports of these.

/**
 * Health = Cribl authenticates the connection credential and answers on its REST
 * API. Obtains a Bearer (on-prem login or Cloud token), then GET /api/v1/system/info.
 * A response below 500 counts as reachable. Verify /api/v1/system/info against a
 * live Cribl.
 */
export async function criblHealthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)
  const started = Date.now()
  try {
    const headers = await criblConnect(base, credential, 8000)
    const res = await criblRequest(`${apiRoot(base)}/system/info`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'cribl_reachable',
      passed,
      message: passed ? `Cribl reachable (HTTP ${res.status}).` : `Cribl returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'cribl_reachable',
      passed: false,
      message: `Cribl unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}

/** Deployment status for a Cribl configuration, from platform records. */
export async function criblGetStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latest = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latest) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: [...CRIBL_COMPONENT_TYPES] })
  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || '',
    healthy: latest.healthScore ? latest.healthScore >= 80 : undefined,
    healthScore: latest.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || latest.startedAt,
    componentStatuses,
  }
}
