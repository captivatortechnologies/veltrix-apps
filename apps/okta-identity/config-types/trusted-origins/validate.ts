import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Trusted Origins API constraints ------------------------------------

/**
 * The scope types a trusted origin may grant. A single origin can carry any
 * subset (at least one, at most all three):
 *   - CORS          → cross-origin requests to the Okta API from this origin
 *   - REDIRECT      → this origin may be used as a post-sign-in redirect target
 *   - IFRAME_EMBED  → Okta content may be embedded in an iframe on this origin
 */
export const SCOPE_TYPES = ['CORS', 'REDIRECT', 'IFRAME_EMBED'] as const
export type ScopeType = (typeof SCOPE_TYPES)[number]

/** A trusted origin is ACTIVE or INACTIVE; status changes via the lifecycle endpoints. */
export const TRUSTED_ORIGIN_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** Okta caps a trusted origin name at 255 characters. */
export const MAX_TRUSTED_ORIGIN_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface TrustedOriginSpec {
  sectionName: string
  /** Trusted origin name — the logical identity deploy matches on. */
  name: string
  /** The origin URL (scheme + host + optional port) CORS/redirect/iframe is granted for. */
  origin: string
  /** Granted scope types — a non-empty subset of CORS | REDIRECT | IFRAME_EMBED. */
  scopes: string[]
  /** Desired lifecycle status — ACTIVE | INACTIVE. */
  status: string
}

/**
 * Shape of a trusted origin returned by GET /trustedOrigins. Carries an index
 * signature so a live origin can be handed to helpers typed as
 * `Record<string, unknown>` (e.g. the readOnly-field stripper).
 */
export interface LiveTrustedOrigin {
  id?: string
  name?: string
  origin?: string
  scopes?: Array<{ type?: string; allowedOktaApps?: unknown }>
  status?: string
  created?: string
  lastUpdated?: string
  createdBy?: string
  lastUpdatedBy?: string
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/** Canvas list fields (tags) arrive as arrays, or comma/newline text. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/**
 * True when `origin` is a valid Okta trusted-origin URL: an http/https scheme, a
 * host, an optional port — and NO path, query or fragment (Okta rejects those).
 * Deliberately mirrors Okta's constraint so validate can fail loudly up front.
 */
export function isValidOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.pathname !== '/' && url.pathname !== '') return false
  if (url.search || url.hash) return false
  return true
}

/** The sorted, upper-cased scope types on a live trusted origin. */
export function liveScopeTypes(live: LiveTrustedOrigin): string[] {
  const scopes = Array.isArray(live.scopes) ? live.scopes : []
  return scopes
    .map((s) => (s && typeof s === 'object' && typeof s.type === 'string' ? s.type.trim().toUpperCase() : ''))
    .filter((t) => t.length > 0)
    .sort()
}

/** Each canvas item describes one Okta trusted origin. */
export function extractTrustedOriginSpecs(canvas: CanvasSnapshot): TrustedOriginSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    // Okta stores the origin without a trailing slash; normalise so a trailing
    // slash the user typed does not later read as drift against the live origin.
    const origin =
      typeof fields.origin === 'string' ? fields.origin.trim().replace(/\/+$/, '') : ''

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      origin,
      // Scope types are upper-case enums; normalise so a lower-case entry still
      // matches instead of failing as "invalid".
      scopes: toStringList(fields.scopes).map((s) => s.toUpperCase()),
      status:
        typeof fields.status === 'string' && fields.status.trim()
          ? fields.status.trim().toUpperCase()
          : 'ACTIVE',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate trusted-origin configurations against the Okta Trusted Origins API.
 * Static only — it never contacts Okta:
 *   - name is required, <= 255 chars, and unique within the canvas
 *   - origin is required and a valid scheme://host[:port] URL (no path/query)
 *   - scopes carries at least one of CORS | REDIRECT | IFRAME_EMBED, each valid
 *     and not repeated
 *   - status (when set) is ACTIVE | INACTIVE
 * Trusted origins have no protected/system objects and no write-only secrets.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTrustedOriginSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Trusted origin name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_TRUSTED_ORIGIN_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Trusted origin name must be ${MAX_TRUSTED_ORIGIN_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate trusted origin "${spec.name}" — each origin may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // origin — required and a valid scheme://host[:port] URL (no path/query/fragment)
    if (!spec.origin) {
      errors.push({ field: `${prefix}.origin`, message: 'Origin URL is required', code: 'required' })
    } else if (!isValidOrigin(spec.origin)) {
      errors.push({
        field: `${prefix}.origin`,
        message:
          'Origin must be a valid URL of the form scheme://host[:port] with an http or https scheme and no path, query or fragment, e.g. https://app.example.com or http://localhost:3000',
        code: 'invalid_origin',
      })
    }

    // scopes — at least one, each a valid type, no duplicates
    if (spec.scopes.length === 0) {
      errors.push({
        field: `${prefix}.scopes`,
        message: `At least one scope is required — choose any of: ${SCOPE_TYPES.join(', ')}`,
        code: 'scopes_required',
      })
    } else {
      const seenScopes = new Set<string>()
      for (const scope of spec.scopes) {
        if (!(SCOPE_TYPES as readonly string[]).includes(scope)) {
          errors.push({
            field: `${prefix}.scopes`,
            message: `Scope "${scope}" is not valid — scopes must be one of: ${SCOPE_TYPES.join(', ')}`,
            code: 'invalid_scope',
          })
        } else if (seenScopes.has(scope)) {
          errors.push({
            field: `${prefix}.scopes`,
            message: `Duplicate scope "${scope}" — each scope may only appear once per origin`,
            code: 'duplicate_scope',
          })
        }
        seenScopes.add(scope)
      }
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(TRUSTED_ORIGIN_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${TRUSTED_ORIGIN_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
