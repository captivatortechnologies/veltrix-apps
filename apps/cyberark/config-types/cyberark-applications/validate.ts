import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// CyberArk Applications — validate + shared spec extraction.
//
// An "Application" is an AAM/CCP identity: a caller that the Central
// Credential Provider / Application Access Manager lets retrieve credentials,
// authenticated by ONE OR MORE authentication methods (a signed path, a file
// hash, the OS user running the process, a source machine address, or a
// client-certificate constraint) rather than a password of its own. This is
// the CCP "allowed machines" surface: `machineAddress` IS an allowed-machine
// entry, modeled as one of an application's authentication methods rather
// than a separate config type, because CyberArk itself models it that way
// (a child collection of the application, not an independent resource).
//
// CyberArk assigns no separate id — AppID (case-sensitive, caller-chosen) IS
// the identity, so reconciliation uses it directly as the natural key.
//
// NO SECRET MATERIAL: none of the fields below are credentials. An
// authentication method PROVES the caller's identity (a path/hash/OS
// user/machine/certificate) — it never carries a password or key.
// =============================================================================

/** The 6 classic Application authentication method types. */
export const AUTH_METHOD_TYPES = ['path', 'hash', 'osUser', 'machineAddress', 'certificateserialnumber', 'certificateattr'] as const
export type AuthMethodType = (typeof AUTH_METHOD_TYPES)[number]

const AUTH_METHOD_TYPE_SET = new Set<string>(AUTH_METHOD_TYPES)

/** One authentication method declared for an application (see AUTH_METHOD_TYPES). */
export interface AuthMethodSpec {
  authType: string
  authValue?: string
  isFolder?: boolean
  allowInternalScripts?: boolean
  comment?: string
  issuer?: string[]
  subject?: string[]
  subjectAlternativeName?: string[]
}

export interface ApplicationSpec {
  sectionName: string
  appId: string
  description: string
  location: string
  disabled: boolean
  accessPermittedFromHour: number | null
  accessPermittedToHour: number | null
  expirationDate: string
  businessOwnerFirstName: string
  businessOwnerLastName: string
  businessOwnerEmail: string
  businessOwnerPhone: string
  /** Raw JSON as typed on the canvas — re-parsed by deploy via parseAuthMethods(). */
  authMethodsJson: string
}

/** Shape of an application returned by GET .../Applications/ (only fields we manage). */
export interface LiveApplication {
  AppID?: string
  Description?: string
  Location?: string
  Disabled?: boolean | string
  AccessPermittedFrom?: number
  AccessPermittedTo?: number
  ExpirationDate?: string | number
  BusinessOwnerFName?: string
  BusinessOwnerLName?: string
  BusinessOwnerEmail?: string
  BusinessOwnerPhone?: string
}

/** Shape of an authentication method returned by GET .../Authentications/. */
export interface LiveAuthMethod {
  AuthType?: string
  AuthValue?: string
  IsFolder?: boolean | string
  AllowInternalScripts?: boolean | string
  Comment?: string
  Issuer?: string[]
  Subject?: string[]
  SubjectAlternativeName?: string[]
  // ⚠ The exact id field GET returns is not independently confirmed in the
  // sources available to this app (see cyberark-applications/deploy.ts) — every
  // plausible casing is read defensively wherever an id is needed (DELETE).
  authID?: string | number
  AuthID?: string | number
  id?: string | number
  WebServiceID?: string | number
  WebServiceId?: string | number
}

/** An application's natural key — its AppID, lower-cased for reconciliation. */
export function appKey(spec: { appId: string }): string {
  return spec.appId.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/** Each canvas item describes one CyberArk application. */
export function extractApplicationSpecs(canvas: CanvasSnapshot): ApplicationSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      appId: typeof fields.app_id === 'string' ? fields.app_id.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      location: typeof fields.location === 'string' && fields.location.trim() ? fields.location.trim() : '\\',
      disabled: readBool(fields.disabled, false),
      accessPermittedFromHour: parsePositiveIntOrZero(fields.access_permitted_from_hour),
      accessPermittedToHour: parsePositiveIntOrZero(fields.access_permitted_to_hour),
      expirationDate: typeof fields.expiration_date === 'string' ? fields.expiration_date.trim() : '',
      businessOwnerFirstName: typeof fields.business_owner_first_name === 'string' ? fields.business_owner_first_name.trim() : '',
      businessOwnerLastName: typeof fields.business_owner_last_name === 'string' ? fields.business_owner_last_name.trim() : '',
      businessOwnerEmail: typeof fields.business_owner_email === 'string' ? fields.business_owner_email.trim() : '',
      businessOwnerPhone: typeof fields.business_owner_phone === 'string' ? fields.business_owner_phone.trim() : '',
      authMethodsJson: typeof fields.authentication_methods === 'string' ? fields.authentication_methods : '',
    }
  })
}

/** 0 is a valid hour, unlike parsePositiveInt's "must be > 0" rule. */
function parsePositiveIntOrZero(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

export interface AuthMethodsResult {
  value: AuthMethodSpec[] | null
  error: string | null
}

/**
 * Parse the `authentication_methods` JSON array. Empty string → []. Each entry
 * must declare a recognised `authType`; the type-specific required field is
 * checked (an AuthValue for everything except certificateattr, which needs at
 * least one of issuer/subject/subjectAlternativeName).
 */
export function parseAuthMethods(raw: string): AuthMethodsResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { value: null, error: 'must be a JSON array of authentication method objects' }

  const methods: AuthMethodSpec[] = []
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { value: null, error: `entry [${i}] must be an object` }
    }
    const raw = entry as Record<string, unknown>
    const authType = typeof raw.authType === 'string' ? raw.authType.trim() : ''
    if (!AUTH_METHOD_TYPE_SET.has(authType)) {
      return { value: null, error: `entry [${i}].authType "${authType}" must be one of ${AUTH_METHOD_TYPES.join(', ')}` }
    }
    const method: AuthMethodSpec = { authType }
    if (typeof raw.authValue === 'string') method.authValue = raw.authValue.trim()
    if (raw.isFolder !== undefined) method.isFolder = readBool(raw.isFolder, false)
    if (raw.allowInternalScripts !== undefined) method.allowInternalScripts = readBool(raw.allowInternalScripts, false)
    if (typeof raw.comment === 'string') method.comment = raw.comment.trim()
    if (Array.isArray(raw.issuer)) method.issuer = raw.issuer.filter((v): v is string => typeof v === 'string')
    if (Array.isArray(raw.subject)) method.subject = raw.subject.filter((v): v is string => typeof v === 'string')
    if (Array.isArray(raw.subjectAlternativeName)) {
      method.subjectAlternativeName = raw.subjectAlternativeName.filter((v): v is string => typeof v === 'string')
    }

    if (authType === 'certificateattr') {
      const hasAny = (method.issuer?.length ?? 0) > 0 || (method.subject?.length ?? 0) > 0 || (method.subjectAlternativeName?.length ?? 0) > 0
      if (!hasAny) {
        return { value: null, error: `entry [${i}] (certificateattr) needs at least one of issuer, subject or subjectAlternativeName` }
      }
    } else if (!method.authValue) {
      return { value: null, error: `entry [${i}] (${authType}) requires a non-empty authValue` }
    }

    methods.push(method)
  }
  return { value: methods, error: null }
}

/** A stable signature identifying an authentication method's semantic identity. */
export function authMethodSignature(m: { authType: string; authValue?: string; issuer?: string[]; subject?: string[]; subjectAlternativeName?: string[] }): string {
  return JSON.stringify({
    authType: m.authType,
    authValue: m.authValue ?? null,
    issuer: [...(m.issuer ?? [])].sort(),
    subject: [...(m.subject ?? [])].sort(),
    subjectAlternativeName: [...(m.subjectAlternativeName ?? [])].sort(),
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate application configurations: AppID is required and unique; hour
 * fields (when set) must be 0-23; the authentication-methods JSON (when set)
 * must parse per parseAuthMethods(); an email, when supplied, is loosely
 * shape-checked.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractApplicationSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.appId) {
      errors.push({ field: `${prefix}.app_id`, message: 'Application ID is required', code: 'required' })
    }

    for (const [field, value] of [
      ['access_permitted_from_hour', spec.accessPermittedFromHour],
      ['access_permitted_to_hour', spec.accessPermittedToHour],
    ] as const) {
      if (value !== null && (value < 0 || value > 23)) {
        errors.push({ field: `${prefix}.${field}`, message: `${field} must be between 0 and 23`, code: 'invalid_hour' })
      }
    }

    if (spec.businessOwnerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(spec.businessOwnerEmail)) {
      warnings.push({ field: `${prefix}.business_owner_email`, message: 'Business owner email does not look like a valid address', code: 'suspicious_email' })
    }

    const methods = parseAuthMethods(spec.authMethodsJson)
    if (methods.error) {
      errors.push({ field: `${prefix}.authentication_methods`, message: `Authentication methods ${methods.error}`, code: 'invalid_auth_methods' })
    } else if (methods.value) {
      const sigSeen = new Set<string>()
      methods.value.forEach((m, i) => {
        const sig = authMethodSignature(m)
        if (sigSeen.has(sig)) {
          errors.push({
            field: `${prefix}.authentication_methods[${i}]`,
            message: `Duplicate authentication method (${m.authType}) — each method must be distinct`,
            code: 'duplicate_auth_method',
          })
        }
        sigSeen.add(sig)
      })
    }

    if (spec.appId) {
      const key = appKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.app_id`,
          message: `Duplicate application "${spec.appId}" — each Application ID may only be declared once`,
          code: 'duplicate_application',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
