// =============================================================================
// Shared helpers used across every Sophos Central config type — JSON-blob
// parsing, order-insensitive-key comparison for drift, and the generic
// getStatus every config type re-exports. Mirrors the equivalent
// lib/merakiCommon.ts / lib/falcon.ts helpers in the sibling Cisco Meraki and
// CrowdStrike Falcon apps.
// =============================================================================

import type { ComponentConfigStatus, ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'

/** The Veltrix component type every Sophos Central config type targets: one tenant. */
export const SOPHOS_TENANT_COMPONENT_TYPE = 'sophos-tenant'

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Trim a canvas text value to a plain string, defaulting to ''. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read a canvas number field, returning undefined when absent/blank/non-numeric. */
export function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Stable, key-sorted JSON of a value — for drift comparison. Arrays keep
 * their order (order can be meaningful, e.g. appliesTo id lists); only object
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

/** A subset of `source` limited to `keys` — for comparing only fields we declare. */
export function pickKeys(source: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!source) return out
  for (const k of keys) if (k in source) out[k] = source[k]
  return out
}

/**
 * Parse a JSON textarea into a plain object (rejects arrays and primitives).
 * Used by config types whose vendor schema is authored as a JSON blob
 * (policy `settings` / `appliesTo`) — the Sophos Central Endpoint Policy API
 * is itself schema-light here ("Keys have specific names documented here"),
 * so passing the object through as declared (rather than flattening dozens
 * of policy-type-specific canvas fields) is the honest representation.
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
 * Generic getStatus handler shared by every Sophos Central config type:
 * deployment status comes from the platform's own record of the last
 * successful deploy, plus every registered `sophos-tenant` component.
 */
export async function sophosGetStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latestDeployment = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latestDeployment) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: [SOPHOS_TENANT_COMPONENT_TYPE] })

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
