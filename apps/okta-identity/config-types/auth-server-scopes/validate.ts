import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Authorization Server Scopes API constraints -------------------------
//
// A scope is a CHILD of a custom authorization server. Its logical identity is
// the (authServerId, name) PAIR — the same scope name can exist under different
// authorization servers. Endpoints are all nested under the parent server:
//   GET/POST    /authorizationServers/{authServerId}/scopes
//   GET/PUT/DEL /authorizationServers/{authServerId}/scopes/{scopeId}
// There is NO lifecycle for a scope (no activate/deactivate).

/** Consent handling for a scope — how the user is prompted to grant it. */
export const CONSENT_VALUES = ['REQUIRED', 'IMPLICIT', 'FLEXIBLE'] as const
export type ConsentValue = (typeof CONSENT_VALUES)[number]

/** Whether the scope is published in the auth server's metadata document. */
export const METADATA_PUBLISH_VALUES = ['ALL_CLIENTS', 'NO_CLIENTS'] as const
export type MetadataPublishValue = (typeof METADATA_PUBLISH_VALUES)[number]

/**
 * Okta seeds every authorization server with these OIDC/OAuth reserved scopes.
 * They are `system: true`, so they may NEVER be created, updated or deleted
 * through this app — Okta owns them. validate cannot see a live scope's `system`
 * flag, so it statically rejects these reserved names; deploy / drift / rollback
 * add the live guard (skip any live scope whose `system` is true).
 */
export const RESERVED_SCOPE_NAMES = [
  'openid',
  'profile',
  'email',
  'address',
  'phone',
  'offline_access',
  'device_sso',
] as const

/** True when `name` matches a reserved Okta system scope (case-insensitive). */
export function isReservedScopeName(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return (RESERVED_SCOPE_NAMES as readonly string[]).some((n) => n === lower)
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ScopeSpec {
  sectionName: string
  /** Parent authorization server id (e.g. 'default') — half of the identity. */
  authServerId: string
  /** Scope name — the other half of the (authServerId, name) logical identity. */
  name: string
  /** Human-friendly label shown on the consent prompt. */
  displayName?: string
  /** Free-text description of what the scope grants. */
  description?: string
  /** Consent handling — REQUIRED | IMPLICIT | FLEXIBLE (defaults to IMPLICIT). */
  consent: string
  /** Whether the scope is granted by default when no scopes are requested. */
  default: boolean
  /** Metadata publication — ALL_CLIENTS | NO_CLIENTS (defaults to NO_CLIENTS). */
  metadataPublish: string
  /** Whether the scope is optional (may be omitted from an access token). */
  optional: boolean
}

/** Shape of a scope returned by GET .../scopes and GET .../scopes/{id}. */
export interface LiveScope {
  id?: string
  name?: string
  displayName?: string
  description?: string
  consent?: string
  default?: boolean
  metadataPublish?: string
  optional?: boolean
  /** Set on Okta's built-in scopes (openid/profile/email/…); never managed here. */
  system?: boolean
  created?: string
  lastUpdated?: string
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/**
 * Coerce a canvas checkbox value to a boolean. Checkboxes may arrive as a real
 * boolean or as a string ('true'/'false'/'yes'/'1'); anything else is false.
 */
export function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase()
    return lower === 'true' || lower === 'yes' || lower === '1'
  }
  return false
}

/** Each canvas item describes one Okta authorization-server scope. */
export function extractScopeSpecs(canvas: CanvasSnapshot): ScopeSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const displayName =
      typeof fields.displayName === 'string' && fields.displayName.trim()
        ? fields.displayName.trim()
        : undefined
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined

    return {
      sectionName: section.name,
      authServerId: typeof fields.authServerId === 'string' ? fields.authServerId.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      displayName,
      description,
      // Enums are upper-case; normalise so a lower-case entry still matches.
      consent:
        typeof fields.consent === 'string' && fields.consent.trim()
          ? fields.consent.trim().toUpperCase()
          : 'IMPLICIT',
      default: toBoolean(fields.default),
      metadataPublish:
        typeof fields.metadataPublish === 'string' && fields.metadataPublish.trim()
          ? fields.metadataPublish.trim().toUpperCase()
          : 'NO_CLIENTS',
      optional: toBoolean(fields.optional),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate authorization-server scope configurations. Static only — NO network:
 *   - authServerId is required (the parent server the scope lives under)
 *   - name is required, carries no whitespace (OAuth scope values are
 *     space-delimited), and is not one of Okta's reserved system scopes
 *   - consent, when set, is REQUIRED | IMPLICIT | FLEXIBLE
 *   - metadataPublish, when set, is ALL_CLIENTS | NO_CLIENTS
 *   - the (authServerId, name) PAIR — a scope's logical identity — is unique
 *     per canvas
 *
 * It cannot know a live scope's `system` flag, so the "never modify/delete a
 * system scope" guard lives in deploy / drift / rollback; here it rejects only
 * the reserved system scope NAMES.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScopeSpecs(ctx.canvas)
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // authServerId — required (the parent server the scope is created under)
    if (!spec.authServerId) {
      errors.push({
        field: `${prefix}.authServerId`,
        message: 'Authorization server id is required (e.g. "default") — the scope is created under it',
        code: 'required',
      })
    }

    // name — required, no whitespace, and not a reserved system scope
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Scope name is required', code: 'required' })
    } else {
      if (/\s/.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Scope name must not contain whitespace — OAuth scope values are space-delimited',
          code: 'invalid_name',
        })
      }
      if (isReservedScopeName(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `"${spec.name}" is a reserved Okta system scope (system-managed) — it cannot be created or modified through this app. Choose a different scope name.`,
          code: 'reserved_scope',
        })
      }
    }

    // consent — when set, must be one of the supported values
    if (spec.consent && !(CONSENT_VALUES as readonly string[]).includes(spec.consent)) {
      errors.push({
        field: `${prefix}.consent`,
        message: `Consent must be one of ${CONSENT_VALUES.join(', ')}`,
        code: 'invalid_consent',
      })
    }

    // metadataPublish — when set, must be one of the supported values
    if (spec.metadataPublish && !(METADATA_PUBLISH_VALUES as readonly string[]).includes(spec.metadataPublish)) {
      errors.push({
        field: `${prefix}.metadataPublish`,
        message: `Metadata publish must be one of ${METADATA_PUBLISH_VALUES.join(', ')}`,
        code: 'invalid_metadata_publish',
      })
    }

    // (authServerId, name) PAIR is the scope's logical identity — dedupe on it.
    // authServerId is matched exactly and name case-sensitively (scope names are
    // case-sensitive) to agree with the live match in deploy / drift.
    if (spec.authServerId && spec.name) {
      const key = JSON.stringify([spec.authServerId, spec.name])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate scope "${spec.name}" on authorization server "${spec.authServerId}" — each (authServerId, name) pair may only be declared once per canvas`,
          code: 'duplicate_scope',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
