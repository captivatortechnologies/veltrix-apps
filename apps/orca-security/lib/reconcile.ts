// =============================================================================
// Shared reconciliation helpers for Orca config types.
//
// Orca resources are created / updated by an id the tool ASSIGNS on create.
// Several of Orca's config surfaces publish no "list" endpoint (or only an
// undocumented one), so — exactly like the custom-alerts template — identity is
// the server id this app persists in rollbackData per canvas item. The next
// deploy reads its own prior rollbackData to recover each item's id, matching by
// the stable canvas item id first (so a rename updates the same resource) then
// by the identity name.
//
// These helpers are network-free and generic so every config type reuses the
// same envelope unwrap, id-recovery and rollback-read logic instead of copying
// it. Type-specific body builders stay in each config type's own _shared.ts.
// =============================================================================

import type { PipelineContext } from '@veltrixsecops/app-sdk'

/** The envelope Orca wraps single objects in: { data: {...} }. */
export interface OrcaDataEnvelope<T> {
  data?: T
}

/** Unwrap a `{ data: {...} }` envelope, returning null when absent or non-object. */
export function dataFromEnvelope<T>(payload: unknown): T | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as OrcaDataEnvelope<T>).data
  return data && typeof data === 'object' ? (data as T) : null
}

/** Coerce a canvas value (boolean, 'true'/'false', 1/0, on/off) to a boolean. */
export function normalizeBool(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no' || s === 'disabled' || s === 'off') return false
  if (s === 'true' || s === '1' || s === 'yes' || s === 'enabled' || s === 'on') return true
  return fallback
}

/**
 * Normalize a canvas value to a trimmed, de-duplicated string list. Accepts a
 * `tags`/`multiselect` array or a comma/newline-separated string.
 */
export function normalizeStringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v ?? ''))
    : String(value ?? '').split(/[\n,]/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

/** Coerce a raw keyvalue entry to a string (objects/arrays are JSON-stringified). */
function coerceScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Read a `keyvalue` canvas field into a plain string map. Tolerates the shapes
 * the canvas control (or an imported config) can emit: an object ({ k: v }), an
 * array of `{ key|name, value }` pairs, or a newline/comma-separated "k=v"
 * string. Blank keys are dropped; later entries win on a key collision.
 */
export function readKeyValueMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = String(rec.key ?? rec.name ?? '').trim()
        if (key) out[key] = coerceScalar(rec.value)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim()
      if (k) out[k] = coerceScalar(v)
    }
    return out
  }
  if (typeof value === 'string' && value.trim()) {
    for (const line of value.split(/[\r\n,]+/)) {
      const idx = line.indexOf('=')
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        if (k) out[k] = line.slice(idx + 1).trim()
      }
    }
  }
  return out
}

/** Two string maps are equal when they hold the same keys and values. */
export function stringMapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => b[k] === a[k])
}

/** Discriminated result of parsing a JSON-typed canvas field. */
export type JsonParseResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string }

/** Parse a JSON-typed canvas field, never throwing. An empty value is an error. */
export function parseJsonField<T = unknown>(raw: unknown, label: string): JsonParseResult<T> {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return { ok: false, error: `${label} is empty` }
  try {
    return { ok: true, value: JSON.parse(s) as T }
  } catch (e) {
    return { ok: false, error: `${label} is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
}

/**
 * Order-independent canonical JSON for drift comparison: object keys are sorted
 * recursively so two structurally-equal payloads stringify identically. Arrays
 * keep their order (order can be semantically meaningful, e.g. automation actions).
 */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(obj).sort()) out[key] = sort(obj[key])
      return out
    }
    return v
  }
  try {
    return JSON.stringify(sort(value) ?? null)
  } catch {
    return ''
  }
}

/**
 * One entry recorded per canvas item in rollbackData.previous — the server id
 * this app assigned so the NEXT deploy can update (or rename) the same resource,
 * and rollback can restore the prior body or delete a resource we created.
 */
export interface ReconcileEntry<TPrior = unknown> {
  itemId: string
  name: string
  serverId: string | null
  existed: boolean
  prior: TPrior | null
}

/** The shape deploy writes and rollback/drift read from rollbackData. */
export interface ReconcileData<TPrior = unknown> {
  previous?: ReconcileEntry<TPrior>[]
}

/**
 * Recover the server id a prior deploy assigned to a canvas item. Matches by the
 * stable canvas item id first (survives a rename), then by identity name.
 */
export function priorServerId<TPrior>(
  previous: ReconcileEntry<TPrior>[] | undefined,
  itemId: string,
  name: string,
): string | null {
  if (!previous || previous.length === 0) return null
  const byId = itemId ? previous.find((p) => p.itemId && p.itemId === itemId) : undefined
  if (byId?.serverId) return byId.serverId
  const n = name.trim()
  const byName = n ? previous.find((p) => (p.name ?? '').trim() === n) : undefined
  return byName?.serverId ?? null
}

/** Read this canvas's own prior rollbackData (the ids the last deploy assigned). */
export async function readPriorRollback<TPrior = unknown>(
  ctx: Pick<PipelineContext, 'platform' | 'canvas'>,
): Promise<ReconcileData<TPrior>> {
  try {
    const latest = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = latest?.rollbackData
    if (data && typeof data === 'object') return data as ReconcileData<TPrior>
  } catch {
    // best-effort: no prior data means every item is treated as a create
  }
  return {}
}
