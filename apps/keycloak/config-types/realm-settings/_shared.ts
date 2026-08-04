// Shared helpers for the Keycloak Realm Settings config type (deploy + rollback + drift).
//
// A REALM-WIDE SINGLETON over the full Keycloak RealmRepresentation
// (GET/PUT /admin/realms/{realm}). This config type authors only a narrow field
// subset — token/session lifespans, login-page flags and the password policy.
// Every field below maps 1:1 onto RealmRepresentation by camelCase property
// name; the Tokens fields are plain integers in SECONDS on the wire (Keycloak's
// REST format, not a Terraform-provider duration-string convenience).
//
// CRITICAL secret-safety rule: RealmRepresentation also carries
// smtpServer.password and other sensitive/large fields this config type does
// not author. The full live representation IS safe to use as the PUT body's
// `base` — Keycloak's realm update applies whatever fields are sent on top of
// current state, so spreading the full rep with our fields overridden does not
// reset unrelated settings — but that full representation must NEVER be
// captured into rollbackData, or the platform's rollback-data store would
// persist secrets (e.g. the SMTP password) it has no business holding.
// rollbackData therefore carries ONLY the narrow RealmSettingsProjection below
// — never buildRealmPutBody's merged output, and never a raw realm rep.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Realms") and
// RealmRepresentation's documented field surface.

import { readBool } from '../../lib/fields'
import { parseJson } from '../../lib/keycloakApi'
import type { KeycloakAdminClient } from '../../lib/keycloakApi'

/** The RealmRepresentation field subset this config type reads and writes. */
export interface RealmSettingsProjection {
  accessTokenLifespan?: number
  accessTokenLifespanForImplicitFlow?: number
  ssoSessionIdleTimeout?: number
  ssoSessionMaxLifespan?: number
  ssoSessionIdleTimeoutRememberMe?: number
  ssoSessionMaxLifespanRememberMe?: number
  offlineSessionIdleTimeout?: number
  offlineSessionMaxLifespan?: number
  offlineSessionMaxLifespanEnabled: boolean
  accessCodeLifespan?: number
  accessCodeLifespanLogin?: number
  accessCodeLifespanUserAction?: number
  registrationAllowed: boolean
  registrationEmailAsUsername: boolean
  editUsernameAllowed: boolean
  resetPasswordAllowed: boolean
  rememberMe: boolean
  verifyEmail: boolean
  loginWithEmailAllowed: boolean
  duplicateEmailsAllowed: boolean
  bruteForceProtected: boolean
  passwordPolicy?: string
}

/** Tokens fields: optional non-negative integers, in seconds. Not declared leaves the realm's live value unmanaged. */
export const NUMBER_FIELDS = [
  'accessTokenLifespan',
  'accessTokenLifespanForImplicitFlow',
  'ssoSessionIdleTimeout',
  'ssoSessionMaxLifespan',
  'ssoSessionIdleTimeoutRememberMe',
  'ssoSessionMaxLifespanRememberMe',
  'offlineSessionIdleTimeout',
  'offlineSessionMaxLifespan',
  'accessCodeLifespan',
  'accessCodeLifespanLogin',
  'accessCodeLifespanUserAction',
] as const

/** Login fields: always declared — every one carries a default matching Keycloak's own documented realm defaults. */
export const BOOLEAN_FIELDS = [
  'offlineSessionMaxLifespanEnabled',
  'registrationAllowed',
  'registrationEmailAsUsername',
  'editUsernameAllowed',
  'resetPasswordAllowed',
  'rememberMe',
  'verifyEmail',
  'loginWithEmailAllowed',
  'duplicateEmailsAllowed',
  'bruteForceProtected',
] as const

/** Read an optional non-negative-integer field, or undefined when blank/invalid. */
export function readOptionalNonNegativeInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Project a raw field/property bag (canvas fields OR a live RealmRepresentation) into the declared subset. */
function project(source: Record<string, unknown>): RealmSettingsProjection {
  const projection: RealmSettingsProjection = {
    offlineSessionMaxLifespanEnabled: readBool(source.offlineSessionMaxLifespanEnabled, false),
    registrationAllowed: readBool(source.registrationAllowed, false),
    registrationEmailAsUsername: readBool(source.registrationEmailAsUsername, false),
    editUsernameAllowed: readBool(source.editUsernameAllowed, false),
    resetPasswordAllowed: readBool(source.resetPasswordAllowed, false),
    rememberMe: readBool(source.rememberMe, false),
    verifyEmail: readBool(source.verifyEmail, false),
    loginWithEmailAllowed: readBool(source.loginWithEmailAllowed, true),
    duplicateEmailsAllowed: readBool(source.duplicateEmailsAllowed, false),
    bruteForceProtected: readBool(source.bruteForceProtected, false),
  }

  const accessTokenLifespan = readOptionalNonNegativeInt(source.accessTokenLifespan)
  if (accessTokenLifespan !== undefined) projection.accessTokenLifespan = accessTokenLifespan
  const accessTokenLifespanForImplicitFlow = readOptionalNonNegativeInt(source.accessTokenLifespanForImplicitFlow)
  if (accessTokenLifespanForImplicitFlow !== undefined) {
    projection.accessTokenLifespanForImplicitFlow = accessTokenLifespanForImplicitFlow
  }
  const ssoSessionIdleTimeout = readOptionalNonNegativeInt(source.ssoSessionIdleTimeout)
  if (ssoSessionIdleTimeout !== undefined) projection.ssoSessionIdleTimeout = ssoSessionIdleTimeout
  const ssoSessionMaxLifespan = readOptionalNonNegativeInt(source.ssoSessionMaxLifespan)
  if (ssoSessionMaxLifespan !== undefined) projection.ssoSessionMaxLifespan = ssoSessionMaxLifespan
  const ssoSessionIdleTimeoutRememberMe = readOptionalNonNegativeInt(source.ssoSessionIdleTimeoutRememberMe)
  if (ssoSessionIdleTimeoutRememberMe !== undefined) {
    projection.ssoSessionIdleTimeoutRememberMe = ssoSessionIdleTimeoutRememberMe
  }
  const ssoSessionMaxLifespanRememberMe = readOptionalNonNegativeInt(source.ssoSessionMaxLifespanRememberMe)
  if (ssoSessionMaxLifespanRememberMe !== undefined) {
    projection.ssoSessionMaxLifespanRememberMe = ssoSessionMaxLifespanRememberMe
  }
  const offlineSessionIdleTimeout = readOptionalNonNegativeInt(source.offlineSessionIdleTimeout)
  if (offlineSessionIdleTimeout !== undefined) projection.offlineSessionIdleTimeout = offlineSessionIdleTimeout
  const offlineSessionMaxLifespan = readOptionalNonNegativeInt(source.offlineSessionMaxLifespan)
  if (offlineSessionMaxLifespan !== undefined) projection.offlineSessionMaxLifespan = offlineSessionMaxLifespan
  const accessCodeLifespan = readOptionalNonNegativeInt(source.accessCodeLifespan)
  if (accessCodeLifespan !== undefined) projection.accessCodeLifespan = accessCodeLifespan
  const accessCodeLifespanLogin = readOptionalNonNegativeInt(source.accessCodeLifespanLogin)
  if (accessCodeLifespanLogin !== undefined) projection.accessCodeLifespanLogin = accessCodeLifespanLogin
  const accessCodeLifespanUserAction = readOptionalNonNegativeInt(source.accessCodeLifespanUserAction)
  if (accessCodeLifespanUserAction !== undefined) {
    projection.accessCodeLifespanUserAction = accessCodeLifespanUserAction
  }

  const passwordPolicy = readOptionalString(source.passwordPolicy)
  if (passwordPolicy !== undefined) projection.passwordPolicy = passwordPolicy

  return projection
}

/** Project the canvas item's declared fields into the narrow RealmSettingsProjection. */
export function projectFromFields(fields: Record<string, unknown>): RealmSettingsProjection {
  return project(fields)
}

/** Project the same field subset from a live RealmRepresentation (drift / rollback-capture comparison). */
export function projectFromRealmRep(realm: Record<string, unknown>): RealmSettingsProjection {
  return project(realm)
}

/** Two projections are equal when every Tokens/Login/Password-Policy field matches. */
export function projectionsEqual(a: RealmSettingsProjection, b: RealmSettingsProjection): boolean {
  for (const key of BOOLEAN_FIELDS) {
    if (a[key] !== b[key]) return false
  }
  for (const key of NUMBER_FIELDS) {
    if (a[key] !== b[key]) return false
  }
  return (a.passwordPolicy ?? '') === (b.passwordPolicy ?? '')
}

/**
 * Build the PUT body: the FULL live realm representation spread as `base`, with
 * our declared fields overridden on top. Safe to send as the request body (see
 * the module header) — but the RESULT of this function must never be persisted
 * into rollbackData.
 */
export function buildRealmPutBody(
  liveRealm: Record<string, unknown>,
  desired: RealmSettingsProjection,
): Record<string, unknown> {
  return { ...liveRealm, ...desired }
}

// --- Network ------------------------------------------------------------------

/** Fetch the full live realm representation, fresh (GET /admin/realms/{realm}). */
export async function fetchRealmRep(admin: KeycloakAdminClient): Promise<Record<string, unknown> | null> {
  const res = await admin.get('')
  if (!res.ok) return null
  return parseJson<Record<string, unknown>>(res.body)
}

/** PUT the realm representation — a full replace of whatever fields the body contains. */
export async function putRealmRep(admin: KeycloakAdminClient, rep: Record<string, unknown>): Promise<void> {
  const res = await admin.put('', rep)
  if (!res.ok) throw new Error(`update realm → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
}
