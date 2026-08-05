// =============================================================================
// Shared types + helpers for the PingOne Resources & Scopes config type.
//
// Verified against Ping's own generated OpenAPI docs:
//   https://apidocs.pingidentity.com/pingone/platform/v1/api/#resources
//   https://apidocs.pingidentity.com/pingone/platform/v1/api/#resource-scopes
//
// Model: ONE canvas item = ONE custom API Resource, with its OAuth Scopes
// authored as a nested JSON array (a separately CRUD'd sub-collection under
// `/resources/{resourceId}/scopes`). Scopes are reconciled by name and are
// FULLY SYNCED - a live scope no longer declared in the item's Scopes array
// is DELETED on the next deploy (the same "fully declare, fully replace"
// nested-list pattern this repo uses for Datadog's Sensitive Data Scanner).
//
// PROTECTED BUILT-INS: every PingOne environment ships with non-CUSTOM
// resources (OPENID_CONNECT, PINGONE_API) that already exist and must never
// be created, altered or deleted by this app. `type` is read-only after
// creation and is never sent on create/update - PingOne always infers CUSTOM
// for a resource this app creates. When a declared name matches a LIVE
// resource whose `type !== 'CUSTOM'`, deploy.ts treats it as protected: the
// resource itself and ALL of its scopes are left completely alone.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const INTROSPECT_AUTH_METHODS = ['CLIENT_SECRET_BASIC', 'CLIENT_SECRET_POST', 'NONE'] as const
export type IntrospectAuthMethod = (typeof INTROSPECT_AUTH_METHODS)[number]

export const MAX_NAME_LENGTH = 100
export const MIN_ACCESS_TOKEN_VALIDITY_SECONDS = 300
export const MAX_ACCESS_TOKEN_VALIDITY_SECONDS = 2_592_000
export const DEFAULT_ACCESS_TOKEN_VALIDITY_SECONDS = 3600
export const DEFAULT_INTROSPECT_AUTH_METHOD: IntrospectAuthMethod = 'CLIENT_SECRET_BASIC'
export const CUSTOM_RESOURCE_TYPE = 'CUSTOM'

// --- Resource (parent) shapes ------------------------------------------------------

export interface LiveResource {
  id?: string
  name?: string
  description?: string
  audience?: string
  accessTokenValiditySeconds?: number
  applicationPermissionsSettings?: { claimEnabled?: boolean }
  introspectEndpointAuthMethod?: string
  /** READ-ONLY after creation. Only ever CUSTOM for a resource this app created. */
  type?: string
  [key: string]: unknown
}

export interface ResourceBody {
  name: string
  description: string
  audience: string
  accessTokenValiditySeconds: number
  applicationPermissionsSettings: { claimEnabled: boolean }
  introspectEndpointAuthMethod: string
}

// --- Scope (child) shapes --------------------------------------------------------------

export interface LiveScope {
  id?: string
  name?: string
  description?: string
  [key: string]: unknown
}

export interface ScopeBody {
  name: string
  description: string
}

/** One authored scope object from the canvas JSON array. */
export interface RawScopeJson extends Record<string, unknown> {
  name?: string
  description?: string
}

// --- Canvas item -> spec ------------------------------------------------------------------

export interface ResourceSpec {
  name: string
  description: string
  audience: string
  accessTokenValiditySeconds?: number
  applicationPermissionsClaimEnabled: boolean
  introspectEndpointAuthMethod: string
  /** Raw JSON string of the declared scopes array (see RawScopeJson[]). */
  scopesRaw: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

export function extractResourceSpec(fields: Record<string, unknown>): ResourceSpec {
  return {
    name: str(fields.name),
    description: str(fields.description),
    audience: str(fields.audience),
    accessTokenValiditySeconds: readNumber(fields.accessTokenValiditySeconds),
    applicationPermissionsClaimEnabled: readBool(fields.applicationPermissionsClaimEnabled, false),
    introspectEndpointAuthMethod: str(fields.introspectEndpointAuthMethod) || DEFAULT_INTROSPECT_AUTH_METHOD,
    scopesRaw: typeof fields.scopesJson === 'string' ? fields.scopesJson.trim() : '',
  }
}

export function extractResourceSpecs(canvas: CanvasSnapshot): ResourceSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractResourceSpec(item.fields ?? {}))
}

// --- Identity keys (case-insensitive, mirrors groupKey/ruleKey in datadog) -------------

export function resourceKey(name: string): string {
  return name.trim().toLowerCase()
}
export function scopeKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findResourceByName(resources: LiveResource[], name: string): LiveResource | null {
  const key = resourceKey(name)
  if (!key) return null
  return resources.find((r) => typeof r.name === 'string' && resourceKey(r.name) === key) ?? null
}

/** True when a LIVE resource is (or would be, absent a `type`) a CUSTOM resource this app may manage. */
export function isCustomResource(resource: LiveResource | null | undefined): boolean {
  return (resource?.type ?? CUSTOM_RESOURCE_TYPE) === CUSTOM_RESOURCE_TYPE
}

// --- JSON parsing for the Scopes field ---------------------------------------------------

export interface ParsedScopes {
  value: RawScopeJson[] | undefined
  ok: boolean
}

/** A blank scopesJson is valid and means "no custom scopes" (parses to an empty array). */
export function parseScopesJson(raw: string): ParsedScopes {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { value: [], ok: true }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { value: undefined, ok: false }
  }
  if (!Array.isArray(parsed)) return { value: undefined, ok: false }
  return { value: parsed as RawScopeJson[], ok: true }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// --- Body construction ----------------------------------------------------------------------

/** The audience PingOne assigns when none is declared - resolved explicitly so writes and drift comparisons agree. */
export function resolvedAudience(spec: Pick<ResourceSpec, 'audience' | 'name'>): string {
  return spec.audience || spec.name
}

/** Build the create/update body for a resource. Never includes `type` - PingOne infers CUSTOM. */
export function buildResourceBody(spec: ResourceSpec): ResourceBody {
  return {
    name: spec.name,
    description: spec.description,
    audience: resolvedAudience(spec),
    accessTokenValiditySeconds: spec.accessTokenValiditySeconds ?? DEFAULT_ACCESS_TOKEN_VALIDITY_SECONDS,
    applicationPermissionsSettings: { claimEnabled: spec.applicationPermissionsClaimEnabled },
    introspectEndpointAuthMethod: spec.introspectEndpointAuthMethod || DEFAULT_INTROSPECT_AUTH_METHOD,
  }
}

/** Rebuild a resource write body from a captured LIVE resource (rollback restore path). Never includes `type`. */
export function resourceToBody(resource: LiveResource): ResourceBody {
  return {
    name: String(resource.name ?? ''),
    description: typeof resource.description === 'string' ? resource.description : '',
    audience: typeof resource.audience === 'string' && resource.audience ? resource.audience : String(resource.name ?? ''),
    accessTokenValiditySeconds:
      typeof resource.accessTokenValiditySeconds === 'number'
        ? resource.accessTokenValiditySeconds
        : DEFAULT_ACCESS_TOKEN_VALIDITY_SECONDS,
    applicationPermissionsSettings: { claimEnabled: resource.applicationPermissionsSettings?.claimEnabled ?? false },
    introspectEndpointAuthMethod:
      typeof resource.introspectEndpointAuthMethod === 'string'
        ? resource.introspectEndpointAuthMethod
        : DEFAULT_INTROSPECT_AUTH_METHOD,
  }
}

/** Build the create/update body for one scope, from one authored JSON array entry. */
export function buildScopeBody(raw: RawScopeJson): ScopeBody {
  return {
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    description: typeof raw.description === 'string' ? raw.description : '',
  }
}

/** Rebuild a scope write body from a captured LIVE scope (rollback restore / recreate path). */
export function scopeToBody(scope: LiveScope): ScopeBody {
  return {
    name: String(scope.name ?? ''),
    description: typeof scope.description === 'string' ? scope.description : '',
  }
}
