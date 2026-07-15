import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Application (app instance) API constraints -------------------------

/**
 * The sign-on modes this config type manages (canvas select values). signOnMode
 * discriminates a very different settings/credentials schema per type, so those
 * type-specific parts are authored as JSON blobs. NOTE: SAML_1_1 is deliberately
 * excluded — Okta does not allow creating a SAML 1.1 app instance.
 */
export const SIGN_ON_MODES = [
  'AUTO_LOGIN',
  'BASIC_AUTH',
  'BOOKMARK',
  'BROWSER_PLUGIN',
  'OPENID_CONNECT',
  'SAML_2_0',
  'SECURE_PASSWORD_STORE',
  'WS_FEDERATION',
] as const
export type SignOnMode = (typeof SIGN_ON_MODES)[number]

/** An app is ACTIVE or INACTIVE; status is changed via the lifecycle endpoints. */
export const APP_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** An app label is capped at 100 characters. */
export const MAX_APP_LABEL_LENGTH = 100

/**
 * Sign-on modes whose `name` (the Okta integration key) is REQUIRED on create.
 * Okta pins these apps to a fixed integration template:
 *   OPENID_CONNECT       → name "oidc_client"
 *   BOOKMARK             → name "bookmark"
 *   SECURE_PASSWORD_STORE→ name "template_sps"
 * Custom SAML_2_0 / AUTO_LOGIN apps OMIT name — Okta auto-assigns one.
 */
export const NAME_REQUIRED_SIGN_ON_MODES = ['OPENID_CONNECT', 'BOOKMARK', 'SECURE_PASSWORD_STORE'] as const

/** Sign-on modes where Okta auto-assigns `name` — a supplied name is ignored. */
export const NAME_AUTO_ASSIGNED_SIGN_ON_MODES = ['SAML_2_0', 'AUTO_LOGIN'] as const

/** The common integration key per name-required sign-on mode (for guidance). */
export const COMMON_INTEGRATION_NAMES: Record<string, string> = {
  OPENID_CONNECT: 'oidc_client',
  BOOKMARK: 'bookmark',
  SECURE_PASSWORD_STORE: 'template_sps',
}

/**
 * PROTECTED Okta system apps — never created, updated or deleted through this
 * config type. Okta ships these to run the org itself; touching them can break
 * admin/end-user sign-in. Any app whose `name` starts with `okta_` is protected
 * too, in addition to the explicit list below (saasure is the org's own app and
 * is not okta_-prefixed).
 */
export const PROTECTED_APP_NAMES = [
  'saasure',
  'okta_admin_console',
  'okta_enduser',
  'okta_browser_plugin',
] as const

/** True when `name` is a protected Okta system app (case-insensitive). */
export function isProtectedAppName(name: string | undefined): boolean {
  if (!name) return false
  const lower = name.trim().toLowerCase()
  if (!lower) return false
  if (lower.startsWith('okta_')) return true
  return (PROTECTED_APP_NAMES as readonly string[]).some((n) => n.toLowerCase() === lower)
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AppSpec {
  sectionName: string
  /** User-facing app label — half of the logical identity (label + signOnMode). */
  label: string
  /**
   * Okta integration key (`name`). REQUIRED for OIDC / bookmark / template_sps;
   * OMITTED for custom SAML_2_0 / AUTO_LOGIN (Okta auto-assigns). IMMUTABLE on
   * PUT — Okta ignores a changed name/signOnMode.
   */
  name?: string
  /** Sign-on mode — the other half of the logical identity; IMMUTABLE on PUT. */
  signOnMode: string
  /** Desired lifecycle status — ACTIVE | INACTIVE. */
  status: string
  /** Optional ACCESS_POLICY id to associate after create/update (OIE, LIMITED GA). */
  accessPolicyId?: string
  /** Raw JSON string of the type-specific `settings` object. */
  settingsJson?: string
  /**
   * Raw JSON string of the `credentials` object.
   *
   * SENSITIVE / WRITE-ONLY: credentials.oauthClient.client_secret,
   * credentials.signing.* and any nested `x5c` cert/key material are never
   * returned by Okta on a GET, so they are excluded from drift detection and are
   * only ever written on deploy (see stripCredentialSecrets).
   */
  credentialsJson?: string
  /** Raw JSON string of the `visibility` object. */
  visibilityJson?: string
  /** Raw JSON string of the `accessibility` object. */
  accessibilityJson?: string
  /** Raw JSON string of the `profile` object. */
  profileJson?: string
}

/**
 * Shape of an app returned by GET /apps. Carries an index signature so a live app
 * can be handed to helpers typed as `Record<string, unknown>` and so
 * server-managed keys are readable.
 */
export interface LiveApp {
  id?: string
  label?: string
  name?: string
  signOnMode?: string
  status?: string
  created?: string
  lastUpdated?: string
  settings?: Record<string, unknown>
  credentials?: Record<string, unknown>
  visibility?: Record<string, unknown>
  accessibility?: Record<string, unknown>
  profile?: Record<string, unknown>
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/** The parsed JSON blobs merged into the create/update body. */
export interface AppBlobs {
  settings?: Record<string, unknown>
  credentials?: Record<string, unknown>
  visibility?: Record<string, unknown>
  accessibility?: Record<string, unknown>
  profile?: Record<string, unknown>
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

/** Each canvas item describes one Okta application instance. */
export function extractAppSpecs(canvas: CanvasSnapshot): AppSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const jsonField = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim()
        ? (fields[key] as string).trim()
        : undefined

    return {
      sectionName: section.name,
      label: typeof fields.label === 'string' ? fields.label.trim() : '',
      name: typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : undefined,
      // signOnMode is an upper-case enum; normalise so a lower-case entry still
      // matches instead of failing as "invalid".
      signOnMode: typeof fields.signOnMode === 'string' ? fields.signOnMode.trim().toUpperCase() : '',
      status: typeof fields.status === 'string' ? fields.status.trim().toUpperCase() : 'ACTIVE',
      accessPolicyId:
        typeof fields.accessPolicyId === 'string' && fields.accessPolicyId.trim()
          ? fields.accessPolicyId.trim()
          : undefined,
      settingsJson: jsonField('settingsJson'),
      credentialsJson: jsonField('credentialsJson'),
      visibilityJson: jsonField('visibilityJson'),
      accessibilityJson: jsonField('accessibilityJson'),
      profileJson: jsonField('profileJson'),
    }
  })
}

// --- Write-only secret handling ----------------------------------------------

/** Recursively delete every property named `key` anywhere in the value tree. */
function deepDeleteKey(value: unknown, key: string): void {
  if (Array.isArray(value)) {
    for (const element of value) deepDeleteKey(element, key)
    return
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    if (key in obj) delete obj[key]
    for (const nested of Object.values(obj)) deepDeleteKey(nested, key)
  }
}

/**
 * Return a deep copy of a `credentials` object WITHOUT its write-only secrets:
 *   - credentials.oauthClient.client_secret — the OIDC client secret
 *   - credentials.signing.*                 — signing key material (whole object)
 *   - any nested `x5c`                       — embedded cert/key chains
 *
 * Okta never echoes these back on a GET (they are write-only), so any comparison
 * that kept them would ALWAYS report drift against a live credentials object that
 * cannot return them. Stripping them from BOTH the authored and the live
 * credentials before diffing is exactly how the secrets are excluded from drift
 * detection — they are only ever verified at deploy time, when written. Never
 * mutates the input (deep-clones via a JSON round-trip).
 */
export function stripCredentialSecrets(
  credentials: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(credentials ?? {})) as Record<string, unknown>
  const oauthClient = clone.oauthClient as Record<string, unknown> | undefined
  if (oauthClient && typeof oauthClient === 'object' && 'client_secret' in oauthClient) {
    delete oauthClient.client_secret
  }
  // signing.* — the entire signing key material is write-only.
  if ('signing' in clone) delete clone.signing
  // Any embedded x5c cert/key chain, wherever it appears.
  deepDeleteKey(clone, 'x5c')
  return clone
}

/** Return a deep copy of a blob with any nested `x5c` cert/key material removed. */
export function stripX5c(blob: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(blob ?? {})) as Record<string, unknown>
  deepDeleteKey(clone, 'x5c')
  return clone
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate application-instance configurations against the Okta Apps API. Static
 * only — it never contacts Okta:
 *   - label is required, <= 100 chars, and the (label, signOnMode) identity is
 *     unique within the canvas
 *   - signOnMode is one of the managed modes (SAML_1_1 is not creatable)
 *   - status (when set) is ACTIVE | INACTIVE
 *   - name is REQUIRED for OIDC / bookmark / template_sps; a name given for an
 *     auto-assigned mode (SAML_2_0 / AUTO_LOGIN) is a warning (Okta ignores it)
 *   - name is not a PROTECTED Okta system app (saasure / okta_* …)
 *   - each supplied JSON blob (settings / credentials / …) parses to an OBJECT
 *
 * A live app's `name`/`system` flag cannot be known statically, so the "never
 * touch a protected system app" guard also lives in deploy / drift / rollback;
 * here it rejects the protected NAMES. The write-only credentials secrets are
 * authored here but never drift-checked (see stripCredentialSecrets).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAppSpecs(ctx.canvas)
  const seenIdentities = new Set<string>()

  const blobFields: Array<{ key: keyof AppSpec; label: string; code: string }> = [
    { key: 'settingsJson', label: 'Settings', code: 'invalid_settings' },
    { key: 'credentialsJson', label: 'Credentials', code: 'invalid_credentials' },
    { key: 'visibilityJson', label: 'Visibility', code: 'invalid_visibility' },
    { key: 'accessibilityJson', label: 'Accessibility', code: 'invalid_accessibility' },
    { key: 'profileJson', label: 'Profile', code: 'invalid_profile' },
  ]

  for (const spec of specs) {
    const prefix = spec.sectionName

    // label — required and <= 100 chars
    if (!spec.label) {
      errors.push({ field: `${prefix}.label`, message: 'App label is required', code: 'required' })
    } else if (spec.label.length > MAX_APP_LABEL_LENGTH) {
      errors.push({
        field: `${prefix}.label`,
        message: `App label must be ${MAX_APP_LABEL_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // signOnMode — required and in the supported enum
    if (!spec.signOnMode) {
      errors.push({ field: `${prefix}.signOnMode`, message: 'Sign-on mode is required', code: 'required' })
    } else if (!(SIGN_ON_MODES as readonly string[]).includes(spec.signOnMode)) {
      errors.push({
        field: `${prefix}.signOnMode`,
        message: `Sign-on mode must be one of: ${SIGN_ON_MODES.join(', ')} (SAML_1_1 is not creatable)`,
        code: 'invalid_sign_on_mode',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(APP_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${APP_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // name — protected system apps are off-limits; the integration key is
    // required for OIDC / bookmark / template_sps and auto-assigned otherwise.
    if (isProtectedAppName(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `"${spec.name}" is a protected Okta system app (Okta manages it) — it may not be created, updated or deleted through this app. Remove it from the canvas.`,
        code: 'protected_app',
      })
    }
    if ((NAME_REQUIRED_SIGN_ON_MODES as readonly string[]).includes(spec.signOnMode)) {
      if (!spec.name) {
        errors.push({
          field: `${prefix}.name`,
          message: `A ${spec.signOnMode} app requires an integration name — set name to "${
            COMMON_INTEGRATION_NAMES[spec.signOnMode] ?? 'the integration key'
          }"`,
          code: 'required',
        })
      }
    } else if (spec.name && (NAME_AUTO_ASSIGNED_SIGN_ON_MODES as readonly string[]).includes(spec.signOnMode)) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Okta auto-assigns the name for a ${spec.signOnMode} app — the supplied name "${spec.name}" will be ignored`,
        code: 'name_ignored',
      })
    }

    // Each supplied JSON blob must parse to a JSON object.
    for (const blob of blobFields) {
      const raw = spec[blob.key] as string | undefined
      if (raw && parseJsonObject(raw) === null) {
        errors.push({
          field: `${prefix}.${String(blob.key)}`,
          message: `${blob.label} must be a valid JSON object`,
          code: blob.code,
        })
      }
    }

    // (label, signOnMode) is the app's logical identity — dedupe on it. label is
    // matched case-insensitively so a de-facto duplicate is caught, and
    // signOnMode exactly, to agree with the live match in deploy / drift.
    if (spec.label && spec.signOnMode) {
      const key = JSON.stringify([spec.label.toLowerCase(), spec.signOnMode])
      if (seenIdentities.has(key)) {
        errors.push({
          field: `${prefix}.label`,
          message: `Duplicate app "${spec.label}" with sign-on mode ${spec.signOnMode} — each (label, signOnMode) identity may only be declared once per canvas`,
          code: 'duplicate_app',
        })
      }
      seenIdentities.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
