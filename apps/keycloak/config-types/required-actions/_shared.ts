// Shared helpers for the Keycloak Required Actions config type (deploy + rollback
// + drift).
//
// Required actions follow the Keycloak Admin REST API
// RequiredActionProviderRepresentation (/admin/realms/{realm}/authentication/required-actions),
// verified directly against Keycloak's RequiredActionProviderRepresentation.java
// source: { alias, name, providerId, enabled, defaultAction, priority, config }.
// `enabled`/`defaultAction` are primitive booleans and `priority` a primitive int
// server-side, so every write carries all three explicitly.
//
// Unlike most identities in this app, GET .../required-actions/{alias} is a DIRECT
// retrieve-by-identity endpoint (200 live / 404 absent) — there is no list+match
// needed, same shape as realm-roles' GET /roles/{role-name}.
//
// A required action a realm has not yet enabled is registered via
// POST .../authentication/register-required-action ({providerId, name}); the
// resulting alias equals the providerId. Verified against Keycloak's
// AuthenticationManagementResource.java source.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Authentication Management" resource).

import { readBool, readKeyValueMap, readString } from '../../lib/fields'

/**
 * Keycloak's well-known built-in required-action aliases (case-sensitive, cited
 * from the official `keycloak_required_action` Terraform resource's built-in
 * actions table and Keycloak's own admin console). Custom SPI-registered
 * providers can add more — this set is used only to WARN on an unrecognized
 * alias, never to reject one.
 */
export const WELL_KNOWN_REQUIRED_ACTIONS = new Set([
  'CONFIGURE_RECOVERY_AUTHN_CODES',
  'CONFIGURE_TOTP',
  'delete_account',
  'delete_credential',
  'idp_link',
  'TERMS_AND_CONDITIONS',
  'UPDATE_PASSWORD',
  'UPDATE_PROFILE',
  'update_user_locale',
  'VERIFY_EMAIL',
  'VERIFY_PROFILE',
  'webauthn-register',
  'webauthn-register-passwordless',
])

/** A required action as returned by GET /admin/realms/{realm}/authentication/required-actions/{alias}. */
export interface KeycloakRequiredActionRep {
  /** The action alias — this config type's identity AND the {alias} path segment. */
  alias?: string
  name?: string
  /** The registered provider factory id. Equals alias on registration; immutable. */
  providerId?: string
  enabled?: boolean
  defaultAction?: boolean
  priority?: number
  config?: Record<string, string>
  [key: string]: unknown
}

/**
 * Read an optional non-negative integer field, tolerating the numeric-string form.
 * Not in ../../lib/fields.ts (which has no number reader), so kept local to this
 * config type.
 */
export function readOptionalInt(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return undefined
  return Math.trunc(n)
}

/**
 * Build the merged RequiredActionProviderRepresentation body from canvas fields.
 * `base` (the live representation — freshly registered or pre-existing) is spread
 * first so unmanaged fields survive, then name/enabled/defaultAction/priority/config
 * are overridden. alias and providerId are never written here — both are immutable
 * once registered. `config` is authoritative (replaced wholesale from the declared
 * key/value map, not merged with the base) so drift comparison never sees
 * server-retained keys we never declared. `priority` keeps the base's value when
 * left blank (an operator leaving it untouched should not reorder the action).
 */
export function buildRequiredActionRep(
  fields: Record<string, unknown>,
  base: KeycloakRequiredActionRep,
): KeycloakRequiredActionRep {
  const priority = readOptionalInt(fields.priority)
  return {
    ...base,
    name: readString(fields.name),
    enabled: readBool(fields.enabled, true),
    defaultAction: readBool(fields.defaultAction, false),
    priority: priority !== undefined ? priority : typeof base.priority === 'number' ? base.priority : 0,
    config: readKeyValueMap(fields.config),
  }
}

/** The fields this config type declares, projected for drift comparison. */
export interface RequiredActionProjection {
  enabled: boolean
  defaultAction: boolean
  priority: number | undefined
  config: Record<string, string>
}

export function projectFromFields(fields: Record<string, unknown>): RequiredActionProjection {
  return {
    enabled: readBool(fields.enabled, true),
    defaultAction: readBool(fields.defaultAction, false),
    priority: readOptionalInt(fields.priority),
    config: readKeyValueMap(fields.config),
  }
}

export function projectFromLive(rep: KeycloakRequiredActionRep): RequiredActionProjection {
  return {
    enabled: readBool(rep.enabled, false),
    defaultAction: readBool(rep.defaultAction, false),
    priority: typeof rep.priority === 'number' ? rep.priority : undefined,
    config: rep.config ?? {},
  }
}
