import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Email Domains API constraints --------------------------------------
//
// Custom email domains are managed with NO upsert (list + match by domain):
//   GET    /api/v1/email-domains               — list all
//   POST   /api/v1/email-domains               — create (409 if the domain exists)
//   GET    /api/v1/email-domains/{id}          — retrieve one
//   PUT    /api/v1/email-domains/{id}          — REPLACE, but only { displayName, userName }
//   DELETE /api/v1/email-domains/{id}          — delete (400 when still in use)
//   POST   /api/v1/email-domains/{id}/verify   — external DNS handshake (NEVER auto-called)
//
// domain, brandId and validationSubdomain are IMMUTABLE — Okta's PUT only accepts
// displayName + userName, so changing any immutable field means delete-and-recreate.

/** The default validation subdomain Okta uses when none is supplied. */
export const DEFAULT_VALIDATION_SUBDOMAIN = 'mail'

/**
 * A soft hostname shape check — a domain that does not look like a hostname is a
 * WARNING (not an error), since Okta is the authority on what it will accept.
 */
export const HOSTNAME_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface EmailDomainSpec {
  sectionName: string
  /** The custom mail domain — the logical identity deploy matches on (IMMUTABLE). */
  domain: string
  /** The brand this email domain is bound to (IMMUTABLE). */
  brandId: string
  /** Sender display name (updatable in place). */
  displayName: string
  /** Sender local-part / username (updatable in place). */
  userName: string
  /** Validation subdomain (IMMUTABLE; defaults to "mail"). */
  validationSubdomain: string
}

/**
 * Shape of an email domain returned by GET /email-domains. Carries an index
 * signature so runtime-only fields (dnsValidationRecords, _embedded, …) are
 * readable and a live domain can be handed to helpers typed as Record.
 * NOTE: dnsValidationRecords is runtime-only and is NOT modeled as a canvas field.
 */
export interface LiveEmailDomain {
  id?: string
  domain?: string
  brandId?: string
  displayName?: string
  userName?: string
  validationSubdomain?: string
  validationStatus?: string
  dnsValidationRecords?: unknown
  _links?: unknown
  [k: string]: unknown
}

/** Trim a canvas field to a string, or '' when absent/non-string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Each canvas item describes one Okta custom email domain. */
export function extractEmailDomainSpecs(canvas: CanvasSnapshot): EmailDomainSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const validationSubdomain = str(fields.validationSubdomain) || DEFAULT_VALIDATION_SUBDOMAIN
    return {
      sectionName: section.name,
      domain: str(fields.domain),
      brandId: str(fields.brandId),
      displayName: str(fields.displayName),
      userName: str(fields.userName),
      validationSubdomain,
    }
  })
}

// --- Body builders shared by deploy -------------------------------------------

/** Build the create (POST) body — carries every field the create endpoint needs. */
export function buildCreateBody(spec: EmailDomainSpec): Record<string, unknown> {
  return {
    domain: spec.domain,
    brandId: spec.brandId,
    validationSubdomain: spec.validationSubdomain,
    displayName: spec.displayName,
    userName: spec.userName,
  }
}

/** Build the update (PUT) body — Okta only accepts displayName + userName. */
export function buildUpdateBody(spec: EmailDomainSpec): Record<string, unknown> {
  return { displayName: spec.displayName, userName: spec.userName }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom email-domain configurations against the Okta Email Domains API.
 * Static only — it never contacts Okta:
 *   - domain is required and unique within the canvas (case-insensitive)
 *   - a domain that does not look like a hostname is a WARNING, not an error
 *   - brandId, displayName and userName are required
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractEmailDomainSpecs(ctx.canvas)
  const seenDomains = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // domain — required, unique (case-insensitive), and hostname-shaped (soft warning)
    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Email domain is required', code: 'required' })
    } else {
      const key = spec.domain.toLowerCase()
      if (seenDomains.has(key)) {
        errors.push({
          field: `${prefix}.domain`,
          message: `Duplicate email domain "${spec.domain}" — each domain may only be declared once per canvas`,
          code: 'duplicate_domain',
        })
      }
      seenDomains.add(key)

      if (!HOSTNAME_PATTERN.test(spec.domain)) {
        warnings.push({
          field: `${prefix}.domain`,
          message: `"${spec.domain}" does not look like a mail hostname (e.g. mail.example.com) — check it before deploying`,
          code: 'suspicious_domain',
        })
      }
    }

    // brandId — required (immutable; deploy binds the domain to this brand)
    if (!spec.brandId) {
      errors.push({ field: `${prefix}.brandId`, message: 'Brand ID is required', code: 'required' })
    }

    // displayName — required (updatable)
    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Sender display name is required', code: 'required' })
    }

    // userName — required (updatable)
    if (!spec.userName) {
      errors.push({ field: `${prefix}.userName`, message: 'Sender username is required', code: 'required' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
