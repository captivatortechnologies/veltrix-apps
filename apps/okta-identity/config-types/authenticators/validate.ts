import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Authenticators API constraints -------------------------------------
//
// An authenticator's logical identity is its `key` (google_otp, okta_email, …).
// Standard okta_* / built-in authenticators are seeded one-per-org: deploy GETs
// the existing one, PUTs its settings and toggles its status via the lifecycle
// endpoints — it NEVER creates them. Only custom_app / custom_otp / external_idp
// and the provider authenticators (duo / onprem_mfa / symantec_vip /
// yubikey_token) are ever created. The custom_* keys support MULTIPLE instances
// distinguished by NAME, so their identity is the (key, name) pair.
//
// There is NO DELETE in the Okta Authenticators API — an authenticator can only
// be activated or deactivated. okta_password is always required and cannot even
// be deactivated.

/** Every authenticator key this config type recognises. */
export const KNOWN_AUTHENTICATOR_KEYS = [
  // Built-in / Okta-provided (one per org — updated + toggled, never created).
  'okta_password',
  'okta_verify',
  'okta_email',
  'phone_number',
  'google_otp',
  'security_question',
  'webauthn',
  'security_key',
  // Provider authenticators (created; carry a `provider` object + secrets).
  'duo',
  'onprem_mfa',
  'symantec_vip',
  'yubikey_token',
  // Custom / federated authenticators (created; multi-instance by name).
  'custom_app',
  'custom_otp',
  'external_idp',
] as const
export type AuthenticatorKey = (typeof KNOWN_AUTHENTICATOR_KEYS)[number]

/**
 * Keys that support MULTIPLE instances in one org, distinguished by name — their
 * logical identity is the (key, name) pair, so `name` is required for them.
 */
export const MULTI_INSTANCE_KEYS = ['custom_app', 'custom_otp', 'external_idp'] as const

/**
 * Keys deploy may CREATE when they are absent. Every other (built-in) key is
 * seeded one-per-org by Okta and is only ever fetched, updated and toggled.
 */
export const CREATABLE_KEYS = [
  'custom_app',
  'custom_otp',
  'external_idp',
  'duo',
  'onprem_mfa',
  'symantec_vip',
  'yubikey_token',
] as const

/**
 * Provider-backed keys — they carry a `provider` object whose `configuration`
 * holds a shared secret / integration key (Duo secretKey + integrationKey;
 * on-prem MFA and Symantec VIP shared secrets). Those secret values are
 * write-only (never returned on GET) and are modelled as password fields.
 */
export const PROVIDER_KEYS = ['duo', 'onprem_mfa', 'symantec_vip', 'yubikey_token'] as const

/** Keys that additionally accept a `provider` object (providers + external IdP). */
export const KEYS_WITH_PROVIDER = [...PROVIDER_KEYS, 'external_idp'] as const

/**
 * Keys that CANNOT be deactivated. okta_password is always required — Okta
 * refuses to deactivate it — so a desired INACTIVE status for it is a no-op.
 */
export const NON_DEACTIVATABLE_KEYS = ['okta_password'] as const

/**
 * The authenticator `type` (category) supplied in a CREATE body, keyed by the
 * creatable authenticator key. Best-effort: on an UPDATE the live object's type
 * is preserved instead, so this only matters for a first create.
 */
export const KEY_TYPES: Record<string, string> = {
  custom_app: 'app',
  custom_otp: 'app',
  external_idp: 'federated',
  duo: 'app',
}

/** An authenticator is ACTIVE or INACTIVE; status changes via the lifecycle. */
export const AUTHENTICATOR_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** Okta caps an authenticator name at 128 characters (console limit). */
export const MAX_AUTHENTICATOR_NAME_LENGTH = 128

export function isKnownKey(key: string): boolean {
  return (KNOWN_AUTHENTICATOR_KEYS as readonly string[]).includes(key)
}
export function isMultiInstanceKey(key: string): boolean {
  return (MULTI_INSTANCE_KEYS as readonly string[]).includes(key)
}
export function isCreatableKey(key: string): boolean {
  return (CREATABLE_KEYS as readonly string[]).includes(key)
}
export function isProviderKey(key: string): boolean {
  return (PROVIDER_KEYS as readonly string[]).includes(key)
}
export function keyAcceptsProvider(key: string): boolean {
  return (KEYS_WITH_PROVIDER as readonly string[]).includes(key)
}
export function isNonDeactivatableKey(key: string): boolean {
  return (NON_DEACTIVATABLE_KEYS as readonly string[]).includes(key)
}

/**
 * An authenticator's logical identity: its key, or `key::name` for a
 * multi-instance (custom_* / external_idp) authenticator. Used to dedupe in
 * validate and to match a live authenticator in deploy / drift / health.
 */
export function authenticatorIdentity(key: string, name: string): string {
  return isMultiInstanceKey(key) ? `${key}::${name}` : key
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AuthenticatorSpec {
  sectionName: string
  /** Logical identity — google_otp, okta_email, custom_app, duo, … */
  key: string
  /** Display name; required for the multi-instance custom_* / external_idp keys. */
  name: string
  /** Desired lifecycle status — ACTIVE | INACTIVE (default ACTIVE). */
  status: string
  /** Raw JSON string of the authenticator `settings` object. */
  settingsJson?: string
  /**
   * Raw JSON string of the `provider` object (type + non-secret configuration).
   * The secret configuration values are modelled separately as password fields.
   */
  providerJson?: string
  /** Write-only provider secret (Duo secretKey / on-prem / Symantec shared secret). */
  secretKey?: string
  /** Write-only Duo integration key. */
  integrationKey?: string
}

/** Shape of an authenticator returned by GET /authenticators (and /{id}). */
export interface LiveAuthenticator {
  id?: string
  key?: string
  /** Category — app | password | phone | email | security_key | federated | … */
  type?: string
  name?: string
  status?: string
  settings?: Record<string, unknown>
  provider?: Record<string, unknown>
  created?: string
  lastUpdated?: string
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/** Each canvas item describes one Okta authenticator. */
export function extractAuthenticatorSpecs(canvas: CanvasSnapshot): AuthenticatorSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const optionalJson = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined
    const optionalSecret = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value : undefined

    return {
      sectionName: section.name,
      // Keys are lower-case snake_case enums; normalise so a stray upper-case
      // entry still matches instead of failing as "unknown".
      key: typeof fields.key === 'string' ? fields.key.trim().toLowerCase() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      status: typeof fields.status === 'string' && fields.status.trim()
        ? fields.status.trim().toUpperCase()
        : 'ACTIVE',
      settingsJson: optionalJson(fields.settingsJson),
      providerJson: optionalJson(fields.providerJson),
      secretKey: optionalSecret(fields.secretKey),
      integrationKey: optionalSecret(fields.integrationKey),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate authenticator configurations against the Okta Authenticators model.
 * Static only — it never contacts Okta:
 *   - key is required and must be a known authenticator key
 *   - name is required for the multi-instance custom_* / external_idp keys
 *   - the logical identity (key, or key+name) is unique within the canvas
 *   - status, when set, is ACTIVE | INACTIVE
 *   - okta_password cannot be deactivated → INACTIVE is warned as a no-op
 *   - settingsJson / providerJson, when set, parse to JSON OBJECTS
 *   - a provider secret set on a non-provider key is a warning (it is ignored)
 *
 * There is NO create/delete guard to enforce here beyond the identity checks:
 * whether a built-in key can be reached is a live concern handled in deploy, and
 * NOTHING is ever deleted (the API has no authenticator delete).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAuthenticatorSpecs(ctx.canvas)
  const seenIdentities = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // key — required and a known authenticator key
    if (!spec.key) {
      errors.push({ field: `${prefix}.key`, message: 'Authenticator key is required', code: 'required' })
    } else if (!isKnownKey(spec.key)) {
      errors.push({
        field: `${prefix}.key`,
        message: `Unknown authenticator key "${spec.key}". Must be one of: ${KNOWN_AUTHENTICATOR_KEYS.join(', ')}`,
        code: 'invalid_key',
      })
    }

    // name — required for the multi-instance keys (identity is key+name);
    // capped for every key when present.
    if (spec.name.length > MAX_AUTHENTICATOR_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Authenticator name must be ${MAX_AUTHENTICATOR_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
    if (spec.key && isMultiInstanceKey(spec.key) && !spec.name) {
      errors.push({
        field: `${prefix}.name`,
        message: `A "${spec.key}" authenticator needs a name — its identity is the (key, name) pair, and several may exist in one org`,
        code: 'required',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(AUTHENTICATOR_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${AUTHENTICATOR_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // okta_password cannot be deactivated — flag INACTIVE as a no-op (warning).
    if (spec.key && isNonDeactivatableKey(spec.key) && spec.status === 'INACTIVE') {
      warnings.push({
        field: `${prefix}.status`,
        message: `"${spec.key}" is a required authenticator and cannot be deactivated — the INACTIVE status will be ignored on deploy`,
        code: 'non_deactivatable',
      })
    }

    // settingsJson — when present it must parse to a JSON object
    if (spec.settingsJson && parseJsonObject(spec.settingsJson) === null) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message:
          'Settings must be a valid JSON object, e.g. {"userVerification":"PREFERRED"} — leave blank to keep the current settings',
        code: 'invalid_settings',
      })
    }

    // providerJson — when present it must parse to a JSON object; and it is only
    // meaningful for the provider / external-IdP keys (warning otherwise).
    if (spec.providerJson) {
      if (parseJsonObject(spec.providerJson) === null) {
        errors.push({
          field: `${prefix}.providerJson`,
          message:
            'Provider must be a valid JSON object, e.g. {"type":"DUO","configuration":{"host":"api-xxxx.duosecurity.com"}}',
          code: 'invalid_provider',
        })
      } else if (spec.key && !keyAcceptsProvider(spec.key)) {
        warnings.push({
          field: `${prefix}.providerJson`,
          message: `"${spec.key}" is not a provider authenticator — the provider object will be ignored on deploy`,
          code: 'provider_ignored',
        })
      }
    }

    // provider secrets — only used by the provider keys; warn if set elsewhere.
    if ((spec.secretKey || spec.integrationKey) && spec.key && !isProviderKey(spec.key)) {
      warnings.push({
        field: `${prefix}.secretKey`,
        message: `"${spec.key}" is not a provider authenticator — the secret / integration key will be ignored on deploy`,
        code: 'secret_ignored',
      })
    }

    // identity uniqueness — key, or key+name for a multi-instance key
    if (spec.key && (!isMultiInstanceKey(spec.key) || spec.name)) {
      const identity = authenticatorIdentity(spec.key, spec.name)
      if (seenIdentities.has(identity)) {
        errors.push({
          field: `${prefix}.key`,
          message: isMultiInstanceKey(spec.key)
            ? `Duplicate authenticator "${spec.key}" named "${spec.name}" — each (key, name) may only be declared once per canvas`
            : `Duplicate authenticator "${spec.key}" — each built-in authenticator may only be declared once per canvas`,
          code: 'duplicate_authenticator',
        })
      }
      seenIdentities.add(identity)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
