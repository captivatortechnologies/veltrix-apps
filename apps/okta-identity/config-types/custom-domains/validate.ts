import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Custom Domains API constraints --------------------------------------
//
// A custom domain is Okta's CUSTOM LOGIN-URL DOMAIN (e.g. login.acme.com — what
// the browser shows during sign-in), managed with NO upsert (list + match by
// domain):
//   GET    /api/v1/domains                       — list all
//   POST   /api/v1/domains                       — create ({ domain, certificateSourceType } ONLY)
//   GET    /api/v1/domains/{id}                  — retrieve one
//   PUT    /api/v1/domains/{id}                  — replace the BRAND ONLY ({ brandId })
//   DELETE /api/v1/domains/{id}                  — delete
//   PUT    /api/v1/domains/{id}/certificate      — upsert (create OR renew) a MANUAL certificate
//   POST   /api/v1/domains/{id}/verify           — external DNS handshake (NEVER auto-called)
//
// `domain` is IMMUTABLE (no rename endpoint — delete-and-recreate to change).
// `brandId` is UPDATABLE at any time via the dedicated replace-brand endpoint —
// unlike Email Domains, a custom domain's brand is NOT immutable. Once a
// certificate has been set to MANUAL, Okta has no endpoint to revert it to
// OKTA_MANAGED (delete-and-recreate). Certificate/chain/key are WRITE-ONLY —
// Okta returns only certificate metadata (expiration/fingerprint/subject),
// never the raw PEM content, so they are re-sent on every deploy and never
// drift-checked.

/** The two certificate source types Okta accepts at create. */
export const CERTIFICATE_SOURCE_TYPES = ['OKTA_MANAGED', 'MANUAL'] as const
export type CertificateSourceType = (typeof CERTIFICATE_SOURCE_TYPES)[number]

/** Custom-domain name cap (Okta enforces a practical hostname length limit). */
export const MAX_DOMAIN_NAME_LENGTH = 255

/**
 * A soft hostname shape check — a domain that does not look like a hostname is
 * a WARNING (not an error), since Okta is the authority on what it will accept.
 */
export const HOSTNAME_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i

/** The single certificate encoding Okta's DomainCertificateType enum accepts. */
export const CERTIFICATE_TYPE = 'PEM' as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface CustomDomainSpec {
  sectionName: string
  /** The custom login-URL domain — the logical identity deploy matches on (IMMUTABLE). */
  domain: string
  /** The brand this domain serves (UPDATABLE via the replace-brand endpoint; '' = leave untouched). */
  brandId: string
  /** OKTA_MANAGED (Okta obtains/renews) or MANUAL (operator-supplied PEM material). */
  certificateSourceType: string
  /** WRITE-ONLY public certificate PEM — set only when certificateSourceType is MANUAL. */
  certificate?: string
  /** WRITE-ONLY certificate chain PEM. */
  certificateChain?: string
  /** WRITE-ONLY private key PEM — Okta never returns it; never drift-checked. */
  privateKey?: string
}

/** Shape of a domain returned by GET /domains (list) or GET /domains/{id}. */
export interface LiveCustomDomain {
  id?: string
  domain?: string
  brandId?: string
  certificateSourceType?: string
  validationStatus?: string
  dnsRecords?: Array<{ fqdn?: string; recordType?: string; values?: string[]; expiration?: string }>
  publicCertificate?: { expiration?: string; fingerprint?: string; subject?: string }
  _links?: unknown
  [k: string]: unknown
}

/** Trim a canvas field to a string, or '' when absent/non-string. */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Preserve a secret's EXACT characters (PEM material is whitespace-sensitive),
 * but treat a whitespace-only value as blank (undefined).
 */
export function preserveSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim().length > 0 ? value : undefined
}

/** True when certificateSourceType (case-insensitive) is MANUAL. */
export function isManualCertificate(certificateSourceType: string): boolean {
  return certificateSourceType.trim().toUpperCase() === 'MANUAL'
}

/** Each canvas item describes one Okta custom domain. */
export function extractCustomDomainSpecs(canvas: CanvasSnapshot): CustomDomainSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      domain: str(fields.domain),
      brandId: str(fields.brandId),
      certificateSourceType: str(fields.certificateSourceType).toUpperCase() || 'OKTA_MANAGED',
      certificate: preserveSecret(fields.certificate),
      certificateChain: preserveSecret(fields.certificateChain),
      privateKey: preserveSecret(fields.privateKey),
    }
  })
}

/** True when the spec carries at least one piece of manual certificate material. */
export function hasAnyCertMaterial(spec: CustomDomainSpec): boolean {
  return Boolean(spec.certificate || spec.certificateChain || spec.privateKey)
}

/** True when the spec carries every piece of manual certificate material Okta requires. */
export function hasFullCertMaterial(spec: CustomDomainSpec): boolean {
  return Boolean(spec.certificate && spec.certificateChain && spec.privateKey)
}

// --- Body builders shared by deploy -------------------------------------------

/** Build the create (POST) body — Okta's DomainRequest accepts ONLY these two fields. */
export function buildCreateBody(spec: CustomDomainSpec): Record<string, unknown> {
  return { domain: spec.domain, certificateSourceType: spec.certificateSourceType }
}

/** Build the replace-brand (PUT /domains/{id}) body — Okta's UpdateDomain accepts ONLY brandId. */
export function buildBrandBody(brandId: string): Record<string, unknown> {
  return { brandId }
}

/** Build the upsert-certificate (PUT /domains/{id}/certificate) body. */
export function buildCertificateBody(spec: CustomDomainSpec): Record<string, unknown> {
  return {
    type: CERTIFICATE_TYPE,
    certificate: spec.certificate,
    certificateChain: spec.certificateChain,
    privateKey: spec.privateKey,
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom-domain configurations against the Okta Custom Domains API.
 * Static only — it never contacts Okta:
 *   - domain is required, <= 255 chars, unique within the canvas (case-insensitive)
 *   - a domain that does not look like a hostname is a WARNING, not an error
 *   - certificateSourceType is required and one of OKTA_MANAGED | MANUAL
 *   - MANUAL with SOME but not ALL of certificate/certificateChain/privateKey is
 *     an ERROR (Okta's upsert-certificate endpoint requires all three together)
 *   - MANUAL with NONE of the three is a WARNING (valid when only editing other
 *     fields on an already-certificated domain; required to CREATE one)
 *   - OKTA_MANAGED with any certificate field set is a WARNING (ignored)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCustomDomainSpecs(ctx.canvas)
  const seenDomains = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // domain — required, <= 255 chars, unique (case-insensitive), hostname-shaped (soft warning)
    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Custom domain is required', code: 'required' })
    } else {
      if (spec.domain.length > MAX_DOMAIN_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.domain`,
          message: `Custom domain must be ${MAX_DOMAIN_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.domain.toLowerCase()
      if (seenDomains.has(key)) {
        errors.push({
          field: `${prefix}.domain`,
          message: `Duplicate custom domain "${spec.domain}" — each domain may only be declared once per canvas`,
          code: 'duplicate_domain',
        })
      }
      seenDomains.add(key)

      if (!HOSTNAME_PATTERN.test(spec.domain)) {
        warnings.push({
          field: `${prefix}.domain`,
          message: `"${spec.domain}" does not look like a hostname (e.g. login.example.com) — check it before deploying`,
          code: 'suspicious_domain',
        })
      }
    }

    // certificateSourceType — required and in the enum
    if (!spec.certificateSourceType) {
      errors.push({
        field: `${prefix}.certificateSourceType`,
        message: 'Certificate Source is required',
        code: 'required',
      })
    } else if (!(CERTIFICATE_SOURCE_TYPES as readonly string[]).includes(spec.certificateSourceType)) {
      errors.push({
        field: `${prefix}.certificateSourceType`,
        message: `Certificate Source must be one of: ${CERTIFICATE_SOURCE_TYPES.join(', ')}`,
        code: 'invalid_certificate_source',
      })
    }

    const manual = isManualCertificate(spec.certificateSourceType)
    const hasAny = hasAnyCertMaterial(spec)
    const hasFull = hasFullCertMaterial(spec)

    if (manual) {
      if (hasAny && !hasFull) {
        errors.push({
          field: `${prefix}.certificate`,
          message:
            'A MANUAL certificate needs Certificate, Certificate Chain AND Private Key together — Okta rejects a partial upsert',
          code: 'incomplete_certificate',
        })
      } else if (!hasAny) {
        warnings.push({
          field: `${prefix}.certificate`,
          message:
            'Certificate Source is MANUAL but no certificate material was provided — required to CREATE this domain; leave blank only when updating an already-certificated domain without rotating its certificate',
          code: 'missing_certificate',
        })
      }
    } else if (hasAny) {
      warnings.push({
        field: `${prefix}.certificate`,
        message: 'Certificate fields are ignored for an OKTA_MANAGED domain — set Certificate Source to Manual to use them',
        code: 'certificate_ignored',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
