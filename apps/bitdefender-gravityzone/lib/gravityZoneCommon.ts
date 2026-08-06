// =============================================================================
// Shared helpers used across every GravityZone config type — canvas field
// parsing, JSON-blob parsing, order-insensitive-list comparison for drift, the
// generic getStatus every config type re-exports, and defensive readers for
// GravityZone response shapes this app's research could not fully pin down
// from a live tenant (see README.md "Known limitations"). Mirrors
// lib/sophosCommon.ts in the sibling Sophos Central app.
// =============================================================================

import type { ComponentConfigStatus, ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'

/** The Veltrix component type every GravityZone config type targets: one Control Center tenant/company. */
export const GRAVITYZONE_TENANT_COMPONENT_TYPE = 'gravityzone-tenant'

/** Trim a canvas text value to a plain string, defaulting to ''. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a canvas number field, returning undefined when absent/blank/non-numeric. */
export function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}

/** Split a comma/newline separated canvas value (or array) into trimmed strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Order-insensitive equality of two string lists. */
export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((item) => bSet.has(item))
}

/**
 * Stable, key-sorted JSON of a value — for drift comparison of opaque JSON
 * blob fields (see parseJsonObject). Arrays keep their order; only object
 * keys are sorted so key order never causes a false diff.
 */
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

/**
 * Parse a JSON textarea into a plain object (rejects arrays and primitives).
 * The Configuration Canvas has no dedicated "json" field type (see
 * CANVAS_FIELD_TYPES in the platform validator), so every GravityZone field
 * whose vendor shape is a free-form object — a policy's module `settings`, a
 * package's `modules`/`scanMode`/`roles`/`deploymentOptions`, an account's
 * `rights`, an integration's `specifics` — is authored as a "textarea" of
 * JSON and passed through as declared, the same convention
 * lib/sophosCommon.ts uses for Sophos Central's equally open policy `settings`.
 */
export function parseJsonObject(raw: unknown, label: string): { value: Record<string, unknown> | null; error: string | null } {
  const text = String(raw ?? '').trim()
  if (!text) return { value: {}, error: null }
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

/**
 * Parse a JSON textarea into a plain array (rejects objects and primitives).
 * Same rationale as parseJsonObject, for the handful of GravityZone fields
 * whose vendor shape is a free-form ARRAY (e.g. accounts.notificationsSettings).
 */
export function parseJsonArray(raw: unknown, label: string): { value: unknown[] | null; error: string | null } {
  const text = String(raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { value: null, error: `${label} is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) {
    return { value: null, error: `${label} must be a JSON array.` }
  }
  return { value: parsed, error: null }
}

/**
 * Read the first present, non-empty id-shaped field from a GravityZone
 * response object. This app's research (the public support docs plus the
 * independent n8n-nodes-gravityzone TypeScript client — see lib/gravityZone.ts)
 * confirmed every create/list method's PARAMETERS precisely, but several
 * methods' exact response id key was not independently observed against a
 * live tenant. Reading several plausible key names defensively — rather than
 * assuming one — mirrors apps/teleport's handling of its own unverified
 * Machine ID bot read-back casing (see that app's README "Known limitations").
 */
export function readId(obj: Record<string, unknown> | null | undefined, candidates: string[] = ['id']): string {
  if (!obj) return ''
  for (const key of candidates) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

/**
 * Unwrap a GravityZone list-method result into its item array. Every
 * list method's PARAMETERS (page/perPage/filters) are confirmed against the
 * support docs, but the exact envelope key was only independently observed as
 * "items" for some methods — this defensively also accepts the bare result
 * being the array itself, and falls back to an empty list rather than
 * throwing, so a shape surprise degrades to "no items found" instead of a
 * crash.
 */
export function unwrapListItems<T>(result: unknown, candidateKeys: string[] = ['items']): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object') {
    for (const key of candidateKeys) {
      const val = (result as Record<string, unknown>)[key]
      if (Array.isArray(val)) return val as T[]
    }
  }
  return []
}

/**
 * Page through a GravityZone list method to completion. GravityZone's list
 * methods document `page` (1-based) and `perPage` (max 100) parameters but
 * not a total-pages field this app could rely on, so this keeps requesting
 * the next page until one comes back shorter than `perPage`, or after
 * `maxPages` as a runaway-loop safety cap.
 */
export async function listAllPaged<T>(fetchPage: (page: number, perPage: number) => Promise<T[]>, perPage = 100, maxPages = 100): Promise<T[]> {
  const items: T[] = []
  let page = 1
  while (page <= maxPages) {
    const pageItems = await fetchPage(page, perPage)
    items.push(...pageItems)
    if (pageItems.length < perPage) break
    page++
  }
  return items
}

/**
 * Generic getStatus handler shared by every GravityZone config type:
 * deployment status comes from the platform's own record of the last
 * successful deploy, plus every registered `gravityzone-tenant` component.
 */
export async function gzGetStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latestDeployment = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latestDeployment) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: [GRAVITYZONE_TENANT_COMPONENT_TYPE] })

  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || '',
    healthy: latestDeployment.healthScore != null ? latestDeployment.healthScore >= 80 : undefined,
    healthScore: latestDeployment.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || latestDeployment.startedAt,
    componentStatuses,
  }
}
