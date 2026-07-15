import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault login MFA method constraints --------------------------------------
//
// A login MFA method lives under `/identity/mfa/method/{type}` where the type is
// one of totp | duo | okta | pingid. Its real identity is a server-assigned
// `method_id` UUID — there is NO name-in-path form, so `method_name` (a Vault
// 1.13+ label) is the only stable handle a human can reconcile on. deploy /
// drift / healthCheck all LIST the type, GET each method and match on
// `method_name`; this file's `methodName` is that reconciliation key.
//
// WRITE-ONLY SECRETS: duo (integration_key, secret_key), okta (api_token) and
// pingid (settings_file_base64) carry secrets Vault NEVER returns on GET. They
// are modelled as explicit `fieldType: password` fields, required, and re-sent on
// every deploy (create AND update) — they can never be read back or drift-checked
// (see driftDetect.ts). totp has NO secret input (the per-user key is minted by a
// separate endpoint), so a totp method's config is fully readable.

/** The four Vault login MFA method types. Each has its own `{type}` path. */
export const MFA_METHOD_TYPES = ['totp', 'duo', 'okta', 'pingid'] as const
export type MfaMethodType = (typeof MFA_METHOD_TYPES)[number]

/** TOTP hashing algorithms Vault accepts. */
export const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const
/** TOTP passcode lengths Vault accepts. */
export const TOTP_DIGITS = [6, 8] as const
/** TOTP clock-skew tolerance (in periods) Vault accepts. */
export const TOTP_SKEWS = [0, 1] as const

/** method_name is a label, not a path segment — keep it short and human. */
export const MAX_METHOD_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface MfaMethodSpec {
  sectionName: string
  /** The label Vault stores as `method_name` — the RECONCILIATION KEY. */
  methodName: string
  /** totp | duo | okta | pingid ('' when unset / unrecognized). */
  type: MfaMethodType | ''

  // --- totp (no secret) ---
  /** totp: issuer shown in the authenticator app (required for totp). */
  issuer?: string
  /** totp: token period in seconds. */
  period?: number
  /** totp: generated key size in bytes. */
  keySize?: number
  /** totp: SHA1 | SHA256 | SHA512. */
  algorithm?: string
  /** totp: passcode length (6 | 8). */
  digits?: number
  /** totp: allowed clock skew in periods (0 | 1). */
  skew?: number
  /** totp: max failed validation attempts before the key is locked. */
  maxValidationAttempts?: number

  // --- duo ---
  /** duo: Duo API hostname, e.g. api-XXXX.duosecurity.com (required for duo). */
  apiHostname?: string
  /** duo: WRITE-ONLY secret — Duo integration key (required for duo). */
  integrationKey?: string
  /** duo: WRITE-ONLY secret — Duo secret key (required for duo). */
  secretKey?: string
  /** duo: extra info shown in the Duo push prompt. */
  pushInfo?: string
  /** duo: send a passcode instead of a push. */
  usePasscode?: boolean

  // --- okta ---
  /** okta: Okta organization name (required for okta). */
  orgName?: string
  /** okta: WRITE-ONLY secret — Okta API token (required for okta). */
  apiToken?: string
  /** okta: Okta base URL, e.g. okta.com (defaults to Okta's if blank). */
  baseUrl?: string
  /** okta: match users by their primary email instead of login. */
  primaryEmail?: boolean

  // --- pingid ---
  /** pingid: WRITE-ONLY secret — base64 settings file from PingID (required). */
  settingsFileBase64?: string

  // --- shared (duo / okta / pingid) ---
  /** A format string used to derive the MFA username from the entity alias. */
  usernameFormat?: string
}

/**
 * Shape of a method returned by GET /identity/mfa/method/{type}/{method_id}
 * (usually under a `data` wrapper). Only NON-SECRET fields are modelled — the
 * write-only secrets (integration_key, secret_key, api_token,
 * settings_file_base64) are never returned, and pingid's derived read-only
 * fields (idp_url, admin_url, …) are intentionally omitted so drift never
 * compares against them. `[key: string]` keeps the extra derived fields typed
 * loosely without pulling them into any diff.
 */
export interface LiveMfaMethod {
  method_id?: string
  id?: string
  method_name?: string
  type?: string
  // totp (all non-secret)
  issuer?: string
  period?: number | string
  key_size?: number | string
  algorithm?: string
  digits?: number | string
  skew?: number | string
  max_validation_attempts?: number | string
  // duo (non-secret)
  api_hostname?: string
  push_info?: string
  use_passcode?: boolean
  // okta (non-secret)
  org_name?: string
  base_url?: string
  primary_email?: boolean
  // shared
  username_format?: string
  [key: string]: unknown
}

/** Trim a value to a non-empty string, or undefined. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Preserve a secret's EXACT characters (it may contain spaces or punctuation),
 * but treat a whitespace-only value as blank (undefined). Secrets are required,
 * so validate rejects an undefined one — this only distinguishes "set" from
 * "blank".
 */
function optionalSecret(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : ''
  return raw.trim() ? raw : undefined
}

/**
 * Coerce a numeric field (a `number` input or a `select`'s string value) to a
 * number. Blank → undefined; a non-numeric value → NaN so validate can reject
 * it (NaN is still a `number`, keeping the spec type clean).
 */
export function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  const s = String(value).trim()
  if (!s) return undefined
  const n = Number(s)
  return Number.isNaN(n) ? NaN : n
}

/** Coerce a checkbox value to a boolean, defaulting when unset. */
function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/** Normalize a raw type value to one of the known types, or '' when unknown. */
function normalizeType(value: unknown): MfaMethodType | '' {
  const t = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (MFA_METHOD_TYPES as readonly string[]).includes(t) ? (t as MfaMethodType) : ''
}

/** Each canvas section describes one login MFA method. */
export function extractMfaMethodSpecs(canvas: CanvasSnapshot): MfaMethodSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      methodName: typeof fields.methodName === 'string' ? fields.methodName.trim() : '',
      type: normalizeType(fields.type),

      // totp
      issuer: optionalString(fields.issuer),
      period: optionalNumber(fields.period),
      keySize: optionalNumber(fields.keySize),
      algorithm: optionalString(fields.algorithm),
      digits: optionalNumber(fields.digits),
      skew: optionalNumber(fields.skew),
      maxValidationAttempts: optionalNumber(fields.maxValidationAttempts),

      // duo
      apiHostname: optionalString(fields.apiHostname),
      integrationKey: optionalSecret(fields.integrationKey),
      secretKey: optionalSecret(fields.secretKey),
      pushInfo: optionalString(fields.pushInfo),
      usePasscode: toBool(fields.usePasscode, false),

      // okta
      orgName: optionalString(fields.orgName),
      apiToken: optionalSecret(fields.apiToken),
      baseUrl: optionalString(fields.baseUrl),
      primaryEmail: toBool(fields.primaryEmail, false),

      // pingid
      settingsFileBase64: optionalSecret(fields.settingsFileBase64),

      // shared
      usernameFormat: optionalString(fields.usernameFormat),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate login MFA method configurations against Vault's per-type constraints
 * (no network):
 *   - method_name (the reconciliation key) is required, capped and unique per
 *     canvas (its live identity is a server UUID, so the label is all we have to
 *     dedupe on);
 *   - type is one of totp | duo | okta | pingid;
 *   - the per-type REQUIRED fields are present, including the write-only secrets
 *     (duo integration_key + secret_key, okta api_token, pingid
 *     settings_file_base64) — these are re-asserted on every deploy, so unlike a
 *     keep-existing password they are required here too;
 *   - totp numeric / enum params are in range (algorithm, digits, skew, positive
 *     period / key_size / max_validation_attempts).
 *
 * Static only — it cannot (and must not) verify the secret VALUES: they are
 * write-only and never returned by the API.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMfaMethodSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // method_name — required, capped, and the logical identity we reconcile on.
    if (!spec.methodName) {
      errors.push({ field: `${prefix}.methodName`, message: 'Method name is required', code: 'required' })
    } else if (spec.methodName.length > MAX_METHOD_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.methodName`,
        message: `Method name must be ${MAX_METHOD_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // type — required, one of the four known method types.
    if (!spec.type) {
      errors.push({
        field: `${prefix}.type`,
        message: 'Method type is required and must be one of totp, duo, okta, pingid',
        code: 'invalid_type',
      })
    } else {
      validatePerType(spec, prefix, errors)
    }

    // method_name is the reconciliation key — dedupe on it (matched exactly, so
    // the dedup key equals the create-vs-update match key in deploy).
    if (spec.methodName) {
      if (seenNames.has(spec.methodName)) {
        errors.push({
          field: `${prefix}.methodName`,
          message: `Duplicate method name "${spec.methodName}" — each MFA method name may only be declared once per canvas`,
          code: 'duplicate_method',
        })
      }
      seenNames.add(spec.methodName)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Apply the required-field and value checks specific to the chosen type. */
function validatePerType(spec: MfaMethodSpec, prefix: string, errors: ValidationResult['errors']): void {
  const req = (field: string, value: string | undefined, label: string) => {
    if (!value) errors.push({ field: `${prefix}.${field}`, message: `${label} is required for a ${spec.type} method`, code: 'required' })
  }

  switch (spec.type) {
    case 'totp': {
      req('issuer', spec.issuer, 'Issuer')

      if (spec.algorithm !== undefined && !(TOTP_ALGORITHMS as readonly string[]).includes(spec.algorithm)) {
        errors.push({
          field: `${prefix}.algorithm`,
          message: 'Algorithm must be one of SHA1, SHA256 or SHA512',
          code: 'invalid_algorithm',
        })
      }
      if (spec.digits !== undefined && !(TOTP_DIGITS as readonly number[]).includes(spec.digits)) {
        errors.push({ field: `${prefix}.digits`, message: 'Digits must be 6 or 8', code: 'invalid_digits' })
      }
      if (spec.skew !== undefined && !(TOTP_SKEWS as readonly number[]).includes(spec.skew)) {
        errors.push({ field: `${prefix}.skew`, message: 'Skew must be 0 or 1', code: 'invalid_skew' })
      }
      requirePositiveInt(errors, `${prefix}.period`, spec.period, 'Period')
      requirePositiveInt(errors, `${prefix}.keySize`, spec.keySize, 'Key size')
      requirePositiveInt(errors, `${prefix}.maxValidationAttempts`, spec.maxValidationAttempts, 'Max validation attempts')
      break
    }
    case 'duo': {
      req('apiHostname', spec.apiHostname, 'API hostname')
      // WRITE-ONLY SECRETS — required and re-asserted on every deploy.
      req('integrationKey', spec.integrationKey, 'Integration key')
      req('secretKey', spec.secretKey, 'Secret key')
      break
    }
    case 'okta': {
      req('orgName', spec.orgName, 'Organization name')
      // WRITE-ONLY SECRET.
      req('apiToken', spec.apiToken, 'API token')
      break
    }
    case 'pingid': {
      // WRITE-ONLY SECRET — the base64 settings file is the whole configuration.
      req('settingsFileBase64', spec.settingsFileBase64, 'Settings file (base64)')
      break
    }
  }
}

/** Push an error when a numeric field is present but not a positive integer. */
function requirePositiveInt(
  errors: ValidationResult['errors'],
  field: string,
  value: number | undefined,
  label: string,
): void {
  if (value === undefined) return
  if (Number.isNaN(value) || !Number.isInteger(value) || value <= 0) {
    errors.push({ field, message: `${label} must be a positive whole number`, code: 'invalid_number' })
  }
}
