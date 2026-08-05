import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Zero Trust Access — mTLS root certificates ---------------------
//
// The root CA certificate Access validates an end-user's client certificate
// against when an Access policy uses a `certificate` rule
// ({"certificate":{}}). It lives under /accounts/{account_id}/access/certificates;
// Cloudflare assigns a server id, so identity for reconciliation is the
// certificate `name`.
//
// Unlike an mTLS client identity, this is a PUBLIC CA certificate — no private
// key is ever involved, so (unlike identity providers / service tokens / Access
// applications' allowed_idps) there is no secret to protect here.
//
// Cloudflare's API makes the certificate CONTENT immutable after creation: POST
// accepts { name, certificate, associated_hostnames }, but PUT only accepts
// { name, associated_hostnames } — there is no way to swap the PEM content of
// an existing certificate. GET likewise never echoes the PEM back (only
// fingerprint/expires_on/created_at/updated_at), so drift cannot verify it
// either — an honest limitation this app documents rather than works around.

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface MtlsCertificateSpec {
  sectionName: string
  name: string
  /** PEM content — sent on CREATE only; Cloudflare's API cannot change it afterward. */
  certificate: string
  /** One hostname per line. */
  associatedHostnames: string[]
}

/** Shape of a certificate returned by GET /access/certificates (PEM content is never echoed back). */
export interface LiveMtlsCertificate {
  id?: string
  name?: string
  associated_hostnames?: string[]
  fingerprint?: string
  expires_on?: string
  created_at?: string
  updated_at?: string
}

/** Split a textarea value into trimmed, non-empty lines. */
export function parseHostnames(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The reconciliation key for a certificate — its name, case-folded. */
export function mtlsCertificateKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item describes one Cloudflare Access mTLS certificate. */
export function extractMtlsCertificateSpecs(canvas: CanvasSnapshot): MtlsCertificateSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      certificate: typeof fields.certificate === 'string' ? fields.certificate.trim() : '',
      associatedHostnames: parseHostnames(fields.associated_hostnames),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate mTLS certificate configurations: a name is required and unique
 * across the canvas (its identity), the certificate must look like a PEM block
 * and is required, and at least one associated hostname is required (PUT
 * requires it on every update, so the app requires it up front).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMtlsCertificateSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Certificate name is required', code: 'required' })
    } else {
      const key = mtlsCertificateKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate certificate name "${spec.name}" — each must be uniquely named`,
          code: 'duplicate_certificate',
        })
      }
      seen.add(key)
    }

    if (!spec.certificate) {
      errors.push({ field: `${prefix}.certificate`, message: 'Certificate (PEM) is required', code: 'required' })
    } else if (!spec.certificate.includes('BEGIN CERTIFICATE')) {
      errors.push({
        field: `${prefix}.certificate`,
        message: 'Certificate must be PEM-encoded (a "-----BEGIN CERTIFICATE-----" block)',
        code: 'invalid_certificate',
      })
    }

    if (spec.associatedHostnames.length === 0) {
      errors.push({
        field: `${prefix}.associated_hostnames`,
        message: 'At least one associated hostname is required',
        code: 'required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
