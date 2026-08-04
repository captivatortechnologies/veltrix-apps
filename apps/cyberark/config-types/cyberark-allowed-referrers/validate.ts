import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// CyberArk Allowed Referrers — validate + shared spec extraction.
//
// A server-wide PVWA security setting: an allow-list of HTTP Referer values
// PVWA accepts requests from (an anti-clickjacking / embedding control).
// There is no natural numeric identity from the caller's side, so
// reconciliation uses the referrer URL itself as the natural key.
//
// CREATE-ONLY OVER REST (verified sources for this app confirm GET + POST
// only — no update/delete endpoint for an individual entry). See deploy.ts
// and README "Coverage" for how this shapes deploy/drift/rollback.
//
// NO SECRET MATERIAL: a referrer URL and its regex flag are plain server
// configuration, never credentials.
// =============================================================================

export interface AllowedReferrerSpec {
  sectionName: string
  referrerUrl: string
  regularExpression: boolean
}

/** Shape of an allowed referrer returned by GET .../AllowedReferrers (only fields we manage). */
export interface LiveAllowedReferrer {
  referrerURL?: string
  regularExpression?: boolean | string
  id?: string | number
  ReferrerID?: string | number
}

/** A referrer's natural key — its URL, lower-cased for reconciliation. */
export function referrerKey(spec: { referrerUrl: string }): string {
  return spec.referrerUrl.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/** Each canvas item describes one allowed referrer entry. */
export function extractAllowedReferrerSpecs(canvas: CanvasSnapshot): AllowedReferrerSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      referrerUrl: typeof fields.referrer_url === 'string' ? fields.referrer_url.trim() : '',
      regularExpression: readBool(fields.regular_expression, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate allowed-referrer configurations: referrer_url is required and
 * unique across the canvas. A non-regex entry is loosely warned about if it
 * doesn't look like a URL (regex mode changes the semantics entirely, so this
 * is a warning, never an error).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAllowedReferrerSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.referrerUrl) {
      errors.push({ field: `${prefix}.referrer_url`, message: 'Referrer URL is required', code: 'required' })
    } else if (!spec.regularExpression && !/^https?:\/\//i.test(spec.referrerUrl)) {
      warnings.push({ field: `${prefix}.referrer_url`, message: 'Referrer URL does not look like an http(s) URL — verify it is correct, or enable "Regular Expression"', code: 'suspicious_referrer' })
    }

    if (spec.referrerUrl) {
      const key = referrerKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.referrer_url`,
          message: `Duplicate referrer "${spec.referrerUrl}" — each referrer URL may only be declared once`,
          code: 'duplicate_referrer',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
