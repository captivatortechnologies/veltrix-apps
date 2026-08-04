// Shared helpers for the Keycloak Client Scopes config type (deploy + rollback +
// drift).
//
// Client scopes follow the Keycloak Admin REST API ClientScopeRepresentation
// (/admin/realms/{realm}/client-scopes). The scope NAME is this config type's
// stable identity, but — unlike realm roles/clients — the list endpoint has no
// server-side name filter, so upsert works by listing all scopes and matching on
// `name` client-side (same shape as groups/_shared.ts's findGroupByName).
//
// Several authored fields (consent-screen visibility/text, token-scope and
// discovery-metadata inclusion, GUI order) are not top-level
// ClientScopeRepresentation properties — Keycloak stores them inside `attributes`
// (a flat Record<string, string>; booleans as the literal strings "true"/"false")
// under fixed keys, verified directly against Keycloak's ClientScopeModel.java
// source constants (DISPLAY_ON_CONSENT_SCREEN, CONSENT_SCREEN_TEXT, GUI_ORDER,
// INCLUDE_IN_TOKEN_SCOPE, INCLUDE_IN_OPENID_PROVIDER_METADATA).
//
// A scope's realm default/optional assignment is not part of
// ClientScopeRepresentation at all — it is reconciled separately via
// GET/PUT/DELETE .../default-default-client-scopes[/{id}] and
// .../default-optional-client-scopes[/{id}], AFTER the scope body is written (same
// "reconcile after the parent object exists" shape as groups/_shared.ts's
// reconcileRealmRoles).
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Client Scopes" and "Realms Admin"
// default/optional client-scope endpoints).

import { readBool, readOptionalString, readString } from '../../lib/fields'
import { parseJson } from '../../lib/keycloakApi'
import type { KeycloakAdminClient } from '../../lib/keycloakApi'

/** A Keycloak client scope as returned by GET /admin/realms/{realm}/client-scopes. */
export interface KeycloakClientScopeRep {
  /** Internal UUID — the {id} path segment for GET/PUT/DELETE .../client-scopes/{id}. */
  id?: string
  /** The scope name — this config type's identity. */
  name?: string
  description?: string
  protocol?: string
  attributes?: Record<string, string>
  [key: string]: unknown
}

// Attribute keys ClientScopeModel.java uses to persist the fields below.
export const ATTR_DISPLAY_ON_CONSENT_SCREEN = 'display.on.consent.screen'
export const ATTR_CONSENT_SCREEN_TEXT = 'consent.screen.text'
export const ATTR_GUI_ORDER = 'gui.order'
export const ATTR_INCLUDE_IN_TOKEN_SCOPE = 'include.in.token.scope'
export const ATTR_INCLUDE_IN_OPENID_PROVIDER_METADATA = 'include.in.openid.provider.metadata'

/** Find a client scope by its exact name (the stable identity), client-side. */
export function findClientScopeByName(scopes: KeycloakClientScopeRep[], name: string): KeycloakClientScopeRep | null {
  const target = name.trim()
  if (!target) return null
  return scopes.find((s) => String(s.name ?? '').trim() === target) ?? null
}

/** Read an optional integer field/attribute value, or undefined when unset/blank/invalid. */
function readOptionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Build the ClientScopeRepresentation body from canvas fields. `base` (the
 * existing live scope, when updating) is spread first so Keycloak-managed fields
 * we do not author (protocolMappers, etc.) survive an update. `base.attributes` is
 * likewise spread first so any attribute keys we do not author survive — only the
 * fixed keys above are ever written here, and `consentScreenText`/`guiOrder` are
 * left untouched (keeping whatever `base` held) when not declared.
 */
export function buildClientScopeRep(
  fields: Record<string, unknown>,
  base?: KeycloakClientScopeRep,
): KeycloakClientScopeRep {
  const rep: KeycloakClientScopeRep = {
    ...(base ?? {}),
    name: readString(fields.name),
    protocol: readString(fields.protocol) || 'openid-connect',
  }
  const description = readOptionalString(fields.description)
  if (description !== undefined) rep.description = description
  else if (base && 'description' in base) rep.description = base.description

  const attributes: Record<string, string> = { ...(base?.attributes ?? {}) }
  attributes[ATTR_DISPLAY_ON_CONSENT_SCREEN] = String(readBool(fields.displayOnConsentScreen, true))
  attributes[ATTR_INCLUDE_IN_TOKEN_SCOPE] = String(readBool(fields.includeInTokenScope, true))
  attributes[ATTR_INCLUDE_IN_OPENID_PROVIDER_METADATA] = String(readBool(fields.includeInOpenidProviderMetadata, true))

  const consentScreenText = readOptionalString(fields.consentScreenText)
  if (consentScreenText !== undefined) attributes[ATTR_CONSENT_SCREEN_TEXT] = consentScreenText

  const guiOrder = readOptionalInt(fields.guiOrder)
  if (guiOrder !== undefined) attributes[ATTR_GUI_ORDER] = String(guiOrder)

  rep.attributes = attributes
  return rep
}

/** The fields this config type declares, projected for drift comparison. */
export interface ClientScopeProjection {
  protocol: string
  displayOnConsentScreen: boolean
  consentScreenText?: string
  includeInTokenScope: boolean
  includeInOpenidProviderMetadata: boolean
  guiOrder?: number
}

export function projectFromFields(fields: Record<string, unknown>): ClientScopeProjection {
  return {
    protocol: readString(fields.protocol) || 'openid-connect',
    displayOnConsentScreen: readBool(fields.displayOnConsentScreen, true),
    consentScreenText: readOptionalString(fields.consentScreenText),
    includeInTokenScope: readBool(fields.includeInTokenScope, true),
    includeInOpenidProviderMetadata: readBool(fields.includeInOpenidProviderMetadata, true),
    guiOrder: readOptionalInt(fields.guiOrder),
  }
}

export function projectFromLive(scope: KeycloakClientScopeRep): ClientScopeProjection {
  const attrs = scope.attributes ?? {}
  return {
    protocol: readString(scope.protocol),
    displayOnConsentScreen: readBool(attrs[ATTR_DISPLAY_ON_CONSENT_SCREEN], true),
    consentScreenText: readOptionalString(attrs[ATTR_CONSENT_SCREEN_TEXT]),
    includeInTokenScope: readBool(attrs[ATTR_INCLUDE_IN_TOKEN_SCOPE], true),
    includeInOpenidProviderMetadata: readBool(attrs[ATTR_INCLUDE_IN_OPENID_PROVIDER_METADATA], true),
    guiOrder: readOptionalInt(attrs[ATTR_GUI_ORDER]),
  }
}

// --- Realm default/optional assignment reconciliation (network) --------------
// Shared by deploy (apply desired state) and rollback (restore prior state).

/** A scope's realm-wide assignment: unassigned, an auto-assigned default, or an opt-in optional. */
export type RealmDefaultState = 'none' | 'default' | 'optional'
export const REALM_DEFAULT_STATES = new Set<string>(['none', 'default', 'optional'])

const DEFAULT_SCOPES_PATH = '/default-default-client-scopes'
const OPTIONAL_SCOPES_PATH = '/default-optional-client-scopes'

/**
 * Read which realm-assignment list (if any) a client scope currently sits in.
 * GET /default-default-client-scopes and GET /default-optional-client-scopes each
 * return the full ClientScopeRepresentation[] currently assigned; this checks
 * whether our scope's id appears in either. Best-effort: an unreadable list is
 * treated as empty rather than raising an error.
 */
export async function resolveRealmDefaultState(
  admin: KeycloakAdminClient,
  scopeId: string,
): Promise<RealmDefaultState> {
  const [defaultsRes, optionalsRes] = await Promise.all([
    admin.get(DEFAULT_SCOPES_PATH),
    admin.get(OPTIONAL_SCOPES_PATH),
  ])
  const defaults = defaultsRes.ok ? (parseJson<KeycloakClientScopeRep[]>(defaultsRes.body) ?? []) : []
  const optionals = optionalsRes.ok ? (parseJson<KeycloakClientScopeRep[]>(optionalsRes.body) ?? []) : []
  if (defaults.some((s) => s.id === scopeId)) return 'default'
  if (optionals.some((s) => s.id === scopeId)) return 'optional'
  return 'none'
}

/**
 * Reconcile a client scope's realm-assignment to `desired`, given its current
 * `prior` state (from resolveRealmDefaultState). Default and optional assignment
 * are mutually exclusive by convention: switching between them first unassigns
 * from whichever list the scope currently occupies, then assigns into the newly
 * declared list. A no-op when desired === prior (including "none" -> "none",
 * which skips both calls).
 *
 * NOTE: PUT .../default-default-client-scopes/{id} and
 * .../default-optional-client-scopes/{id} are documented as taking no request
 * body — verify this against a live Keycloak before relying on it in production.
 */
export async function reconcileRealmDefaultState(
  admin: KeycloakAdminClient,
  scopeId: string,
  desired: RealmDefaultState,
  prior: RealmDefaultState,
): Promise<void> {
  if (desired === prior) return

  if (prior === 'default') {
    const res = await admin.delete(`${DEFAULT_SCOPES_PATH}/${encodeURIComponent(scopeId)}`)
    if (!res.ok && res.status !== 404) {
      throw new Error(`unassign realm-default scope → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  } else if (prior === 'optional') {
    const res = await admin.delete(`${OPTIONAL_SCOPES_PATH}/${encodeURIComponent(scopeId)}`)
    if (!res.ok && res.status !== 404) {
      throw new Error(`unassign realm-optional scope → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }

  if (desired === 'default') {
    const res = await admin.put(`${DEFAULT_SCOPES_PATH}/${encodeURIComponent(scopeId)}`, undefined)
    if (!res.ok) throw new Error(`assign realm-default scope → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  } else if (desired === 'optional') {
    const res = await admin.put(`${OPTIONAL_SCOPES_PATH}/${encodeURIComponent(scopeId)}`, undefined)
    if (!res.ok) throw new Error(`assign realm-optional scope → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
}
