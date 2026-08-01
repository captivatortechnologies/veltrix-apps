// Shared helpers for the Organization Security Configuration config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares ONE org-level GitHub code security configuration (its
// feature settings + enforcement), identified by (org, name). These helpers
// translate between the canvas fields and the GitHub REST shapes on
//   /orgs/{org}/code-security/configurations  (list / create / update / attach)
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/code-security/configurations

/** Feature keys exposed as explicit selects — GitHub property names, 1:1. */
export const CONFIG_FEATURE_KEYS = [
  'advanced_security',
  'dependency_graph',
  'dependabot_alerts',
  'dependabot_security_updates',
  'code_scanning_default_setup',
  'secret_scanning',
  'secret_scanning_push_protection',
  'private_vulnerability_reporting',
] as const

export type ConfigFeatureKey = (typeof CONFIG_FEATURE_KEYS)[number]

/** advanced_security accepts enabled|disabled (not not_set); everything else adds not_set. */
export const SETTING_VALUES = ['enabled', 'disabled', 'not_set'] as const
export type SettingValue = (typeof SETTING_VALUES)[number]

export type AttachScope =
  | ''
  | 'none'
  | 'all'
  | 'all_without_configurations'
  | 'public'
  | 'private_or_internal'
  | 'selected'

/** The desired state one canvas item declares. */
export interface OrgConfigDesired {
  org: string
  name: string
  description: string
  features: Record<string, string>
  additionalSettings: Record<string, string>
  enforcement: 'enforced' | 'unenforced'
  attachScope: AttachScope
  selectedRepositoryIds: number[]
}

/** A code security configuration as returned by GitHub — the slice this app reads. */
export interface CodeSecurityConfiguration {
  id?: number
  name?: string
  description?: string
  enforcement?: string
  /** "global" marks a GitHub-provided (read-only) configuration. */
  target_type?: string
  [key: string]: unknown
}

/** Normalise a setting value ('Enabled' | 'not_set' | ...) to a known value or ''. */
export function normalizeSetting(value: unknown): string {
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'enabled' || s === 'disabled' || s === 'not_set') return s
  return ''
}

/** Read a keyvalue field (object at runtime, JSON string as a fallback) into a string map. */
export function toStringMap(value: unknown): Record<string, string> {
  let obj: unknown = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k.trim()
    if (key) out[key] = typeof v === 'string' ? v.trim() : String(v ?? '')
  }
  return out
}

/** Parse a comma/space/newline separated list of repository ids into positive integers. */
export function parseIdList(value: unknown): number[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): OrgConfigDesired {
  const features: Record<string, string> = {}
  for (const key of CONFIG_FEATURE_KEYS) {
    const v = normalizeSetting(fields[key])
    if (v) features[key] = v
  }
  const enforcementRaw = String(fields.enforcement ?? 'enforced').trim().toLowerCase()
  const scopeRaw = String(fields.attach_scope ?? '').trim().toLowerCase() as AttachScope
  return {
    org: String(fields.org ?? '').trim(),
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    features,
    additionalSettings: toStringMap(fields.additional_settings),
    enforcement: enforcementRaw === 'unenforced' ? 'unenforced' : 'enforced',
    attachScope: scopeRaw === 'none' ? '' : scopeRaw,
    selectedRepositoryIds: parseIdList(fields.selected_repository_ids),
  }
}

/**
 * Build the full configuration body (create) from a desired state: name +
 * description + enforcement + every explicit feature, then any additional
 * settings that an explicit feature has not already set (explicit wins).
 */
export function buildConfigBody(desired: OrgConfigDesired): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: desired.name,
    enforcement: desired.enforcement,
  }
  if (desired.description) body.description = desired.description
  for (const [key, value] of Object.entries(desired.features)) body[key] = value
  for (const [key, value] of Object.entries(desired.additionalSettings)) {
    if (!(key in body)) body[key] = value
  }
  return body
}

/** The subset of a desired body that differs from the live configuration (a PATCH diff). */
export function configBodyChanges(
  desired: OrgConfigDesired,
  live: CodeSecurityConfiguration,
): Record<string, unknown> {
  const full = buildConfigBody(desired)
  const changes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(full)) {
    const current = live[key]
    if (String(current ?? '') !== String(value ?? '')) changes[key] = value
  }
  return changes
}

/** What deploy records per configuration so rollback can restore or delete it. */
export interface OrgConfigRollbackEntry {
  itemId?: string
  org: string
  name: string
  /** Whether the configuration existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** GitHub-assigned numeric id, kept so rollback/reconcile target it directly. */
  id?: number
  /** The full prior configuration (existed=true only) so rollback can PATCH it back. */
  prior?: CodeSecurityConfiguration
}

/** Reconstruct the PATCH body that restores a prior configuration. */
export function restoreBody(prior: CodeSecurityConfiguration): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.name !== undefined) body.name = prior.name
  if (prior.description !== undefined) body.description = prior.description ?? ''
  if (prior.enforcement !== undefined) body.enforcement = prior.enforcement
  for (const key of CONFIG_FEATURE_KEYS) {
    if (prior[key] !== undefined) body[key] = prior[key]
  }
  return body
}
