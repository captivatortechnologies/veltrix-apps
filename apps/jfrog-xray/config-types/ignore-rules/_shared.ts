// =============================================================================
// Shared types + helpers for the JFrog Xray Ignore Rules config type.
// Pure and network-free so validate.ts, deploy.ts, driftDetect.ts and the tests
// all read a canvas item and build an Xray ignore-rule body the same way.
//
// UNLIKE the policy/watch config types, an ignore rule has NO user-chosen name
// — Xray assigns an opaque `id` on create — and the API has no update
// endpoint (create + delete only; see deploy.ts header for citations). So
// identity here is the CANVAS ITEM's own stable `id` (always assigned by the
// platform), never a field value. `notes` is required by the Xray API and
// doubles as this item's canvas display label (see canvas.yaml).
// =============================================================================

import type { CanvasItemSnapshot, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { parseJsonObject, readOptionalString, readStringArray } from '../../lib/fields'

// --- Xray ignore-rule wire shapes ------------------------------------------------

export interface IgnoreComponentRef {
  name: string
  version?: string
  path?: string
}

export interface IgnoreFilters {
  vulnerabilities?: string[]
  cves?: string[]
  licenses?: string[]
  watches?: string[]
  policies?: string[]
  components?: IgnoreComponentRef[]
  git_repositories?: string[]
  'docker-layers'?: string[]
  [extra: string]: unknown
}

/** The create-request body (`POST /xray/api/v1/ignore_rules`) — no `id`, that is server-assigned. */
export interface IgnoreRuleBody {
  notes: string
  expires_at?: string
  ignore_filters: IgnoreFilters
}

/** The GET response shape — adds the server-assigned fields. */
export interface XrayIgnoreRule extends IgnoreRuleBody {
  id: string
  author?: string
  created?: string
  is_expired?: boolean
  project_key?: string
}

// --- Canvas spec extraction ----------------------------------------------------

export interface IgnoreRuleSpec {
  /** The canvas item's own stable id — THE reconciliation key (see module header). Absent only in ad-hoc test fixtures. */
  itemId?: string
  notes: string
  expiresAt?: string
  vulnerabilityIds: string[]
  cveIds: string[]
  licenseNames: string[]
  watchNames: string[]
  policyNames: string[]
  componentNames: string[]
  gitRepositoryNames: string[]
  dockerLayerShas: string[]
  additionalFiltersJson: string
}

/** Read every canvas item as an `IgnoreRuleSpec`. Tolerates the `items`/`sections` alias. */
export function extractIgnoreRuleSpecs(canvas: CanvasSnapshot): IgnoreRuleSpec[] {
  const items: CanvasItemSnapshot[] = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      notes: (typeof f.notes === 'string' ? f.notes : '').trim(),
      expiresAt: readOptionalString(f.expires_at),
      vulnerabilityIds: readStringArray(f.vulnerability_ids),
      cveIds: readStringArray(f.cve_ids),
      licenseNames: readStringArray(f.license_names),
      watchNames: readStringArray(f.watch_names),
      policyNames: readStringArray(f.policy_names),
      componentNames: readStringArray(f.component_names),
      gitRepositoryNames: readStringArray(f.git_repository_names),
      dockerLayerShas: readStringArray(f.docker_layer_shas),
      additionalFiltersJson: typeof f.additional_filters_json === 'string' ? f.additional_filters_json : '',
    }
  })
}

/** Build the `ignore_filters` object from the typed fields + the JSON escape valve (typed fields win per-key). */
export function buildIgnoreFilters(spec: IgnoreRuleSpec): IgnoreFilters {
  const filters: IgnoreFilters = {}
  if (spec.vulnerabilityIds.length > 0) filters.vulnerabilities = spec.vulnerabilityIds
  if (spec.cveIds.length > 0) filters.cves = spec.cveIds
  if (spec.licenseNames.length > 0) filters.licenses = spec.licenseNames
  if (spec.watchNames.length > 0) filters.watches = spec.watchNames
  if (spec.policyNames.length > 0) filters.policies = spec.policyNames
  if (spec.componentNames.length > 0) filters.components = spec.componentNames.map((name) => ({ name }))
  if (spec.gitRepositoryNames.length > 0) filters.git_repositories = spec.gitRepositoryNames
  if (spec.dockerLayerShas.length > 0) filters['docker-layers'] = spec.dockerLayerShas

  const extra = parseJsonObject(spec.additionalFiltersJson)
  return extra.ok ? { ...extra.value, ...filters } : filters
}

/** The full create-request body (`POST /xray/api/v1/ignore_rules`). */
export function buildIgnoreRuleBody(spec: IgnoreRuleSpec): IgnoreRuleBody {
  const body: IgnoreRuleBody = { notes: spec.notes, ignore_filters: buildIgnoreFilters(spec) }
  if (spec.expiresAt) body.expires_at = spec.expiresAt
  return body
}

/** True when a spec declares at least one recognized "objective" filter (typed or via the JSON escape valve). */
export function hasObjectiveFilter(spec: IgnoreRuleSpec): boolean {
  if (spec.vulnerabilityIds.length > 0 || spec.cveIds.length > 0 || spec.licenseNames.length > 0) return true
  const extra = parseJsonObject(spec.additionalFiltersJson)
  if (!extra.ok) return false
  const objectiveKeys = ['vulnerabilities', 'cves', 'licenses', 'operational_risk', 'exposures']
  return objectiveKeys.some((key) => extra.value[key] !== undefined)
}

/**
 * Canonicalize a value to a JSON string with recursively sorted object keys and
 * sorted string arrays, so two structurally-equal-but-differently-ordered
 * bodies compare equal. Used to decide whether a declared rule's content
 * actually changed since the last deploy (Xray has no update endpoint — an
 * unchanged rule is left alone rather than needlessly deleted/recreated).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const sorted = value.map(sortDeep)
    // Only reorder an array when every element is a primitive (a string-set
    // filter) — arrays of objects (e.g. `components`) preserve declared order.
    return sorted.every((v) => v === null || typeof v !== 'object') ? [...sorted].sort() : sorted
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(rec).sort()) out[key] = sortDeep(rec[key])
    return out
  }
  return value
}

/** True when two ignore-rule bodies are content-equal (order-insensitive on filter sets). */
export function bodiesEqual(a: IgnoreRuleBody, b: IgnoreRuleBody): boolean {
  return canonicalize(a) === canonicalize(b)
}
