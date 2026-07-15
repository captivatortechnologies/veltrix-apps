import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault auth-method constraints --------------------------------------------

/** A mount path may contain letters, digits and `_ . / -` (nested paths allowed). */
export const AUTH_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/

/** Vault type names are lowercase slugs (userpass, approle, kubernetes, ldap, …). */
export const AUTH_TYPE_PATTERN = /^[a-z0-9_-]+$/

/**
 * `token/` is Vault's built-in token auth method. It is always mounted and must
 * never be enabled, tuned or disabled by this app — reject it in validate.
 * Compared against the slash-stripped, lower-cased path.
 */
export const PROTECTED_AUTH_PATH = 'token'

/** Allowed listing-visibility values on a mount's tuning. */
export const LISTING_VISIBILITY_VALUES: string[] = ['unauth', 'hidden']

/** Allowed token_type values on a mount's tuning. */
export const TOKEN_TYPE_VALUES: string[] = ['default', 'service', 'batch']

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface AuthMethodSpec {
  sectionName: string
  /** Mount path — the logical identity, slash-stripped (e.g. `userpass`, `kubernetes/prod`). */
  path: string
  /** Auth method type (e.g. userpass). IMMUTABLE once enabled at a path. */
  type: string
  description?: string
  /** Tunable default lease TTL — a Vault duration string ("768h") or seconds ("2764800"). */
  defaultLeaseTtl?: string
  /** Tunable max lease TTL — a Vault duration string or seconds. */
  maxLeaseTtl?: string
  /** listing_visibility tunable: "unauth" (shown on the login page) or "hidden". */
  listingVisibility?: string
  /** token_type tunable: "default" | "service" | "batch". */
  tokenType?: string
}

/** Shape of one entry in the `GET /sys/auth` map (keyed by `"userpass/"`). */
export interface LiveAuthMethod {
  type?: string
  description?: string
  accessor?: string
  config?: Record<string, unknown>
}

/** Shape of `GET /sys/auth/{path}/tune` → `data`. TTLs are echoed in SECONDS. */
export interface LiveAuthTune {
  default_lease_ttl?: number
  max_lease_ttl?: number
  description?: string
  token_type?: string
  listing_visibility?: string
}

/** Slash-strip and trim a raw path so the identity is canonical (`userpass/` → `userpass`). */
export function normalizeAuthPath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^\/+|\/+$/g, '')
}

/** Each canvas section describes one auth-method mount. */
export function extractAuthMethodSpecs(canvas: CanvasSnapshot): AuthMethodSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const opt = (key: string): string | undefined => {
      const value = fields[key]
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }

    return {
      sectionName: section.name,
      path: normalizeAuthPath(fields.path),
      type: typeof fields.type === 'string' ? fields.type.trim() : '',
      description: opt('description'),
      defaultLeaseTtl: opt('defaultLeaseTtl'),
      maxLeaseTtl: opt('maxLeaseTtl'),
      listingVisibility: opt('listingVisibility'),
      tokenType: opt('tokenType'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate auth-method configurations against Vault mount constraints:
 * a path (the logical identity) and a type are required, the path must match the
 * mount-path charset and must not be the protected built-in `token/` method, the
 * type must be a lowercase slug, tuning selects must use known values, and the
 * path must be unique within the canvas. Static rules only — no network calls.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAuthMethodSpecs(ctx.canvas)
  const seenPaths = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // path — required, valid charset, not the protected token/ method, unique
    if (!spec.path) {
      errors.push({ field: `${prefix}.path`, message: 'Auth method path is required', code: 'required' })
    } else {
      if (!AUTH_PATH_PATTERN.test(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: 'Auth method path may contain only letters, digits, and the characters _ . / -',
          code: 'invalid_path',
        })
      }
      // token/ is built in and always mounted — never manage it as code.
      if (spec.path.toLowerCase() === PROTECTED_AUTH_PATH) {
        errors.push({
          field: `${prefix}.path`,
          message: 'The "token/" auth method is built in and protected — it cannot be managed as code',
          code: 'protected_path',
        })
      }
      // path is the mount's logical identity — dedupe on it (matched exactly,
      // aligning with how deploy resolves the live mount by `"<path>/"`).
      if (seenPaths.has(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: `Duplicate auth method path "${spec.path}" — each path may only be declared once per canvas`,
          code: 'duplicate_path',
        })
      }
      seenPaths.add(spec.path)
    }

    // type — required; a lowercase slug (its value is immutable once enabled)
    if (!spec.type) {
      errors.push({
        field: `${prefix}.type`,
        message: 'Auth method type is required (e.g. userpass, approle, kubernetes, ldap)',
        code: 'required',
      })
    } else if (!AUTH_TYPE_PATTERN.test(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: 'Auth method type must be a lowercase slug (letters, digits, dashes, underscores), e.g. userpass',
        code: 'invalid_type',
      })
    }

    // listingVisibility — optional; when set must be a known value
    if (spec.listingVisibility && !LISTING_VISIBILITY_VALUES.includes(spec.listingVisibility)) {
      errors.push({
        field: `${prefix}.listingVisibility`,
        message: 'Listing visibility must be "unauth" or "hidden"',
        code: 'invalid_listing_visibility',
      })
    }

    // tokenType — optional; when set must be a known value
    if (spec.tokenType && !TOKEN_TYPE_VALUES.includes(spec.tokenType)) {
      errors.push({
        field: `${prefix}.tokenType`,
        message: 'Token type must be "default", "service", or "batch"',
        code: 'invalid_token_type',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
