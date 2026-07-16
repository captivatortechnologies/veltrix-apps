import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SiteCredentialSpec {
  sectionName: string
  siteName: string
  name: string
  description: string
  credentialJson: string
  /** ⚠ WRITE-ONLY secret (password / key). Never stored, diffed or logged. */
  secret: string
}

/**
 * Shape of a site credential returned by GET /sites/{id}/site_credentials.
 * `account.password` is masked by the API on read — never trust or diff it.
 */
export interface LiveSiteCredential {
  id?: number
  name?: string
  description?: string
  account?: Record<string, unknown>
}

/** The (siteName, credential name) natural key — a site credential's identity. */
export function credentialKey(spec: { siteName: string; name: string }): string {
  return JSON.stringify([spec.siteName.toLowerCase(), spec.name.toLowerCase()])
}

/**
 * Parse a JSON object field. NON-UNION { value, error } (never a discriminated
 * union — the platform loader can't narrow those). An empty string yields an
 * empty object; the "required" check is handled separately in validate.
 */
export interface JsonParseResult {
  value: Record<string, unknown> | null
  error: string | null
}

export function parseJsonObject(raw: string | undefined): JsonParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** Each canvas item describes one per-site credential. */
export function extractSiteCredentialSpecs(canvas: CanvasSnapshot): SiteCredentialSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      siteName: typeof fields.site_name === 'string' ? fields.site_name.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      credentialJson: typeof fields.credential_json === 'string' ? fields.credential_json : '',
      // Do not trim the secret — leading/trailing characters may be significant.
      secret: typeof fields.secret === 'string' ? fields.secret : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate per-site credential configurations: a site name, credential name,
 * account JSON and secret are required; the account JSON must parse to an object;
 * and the (siteName, credential name) natural key must be unique across the
 * canvas. The secret itself is write-only and is never inspected here beyond the
 * presence check.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSiteCredentialSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.siteName) {
      errors.push({ field: `${prefix}.site_name`, message: 'Site name is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Credential name is required', code: 'required' })
    }

    if (!spec.credentialJson.trim()) {
      errors.push({ field: `${prefix}.credential_json`, message: 'Account (JSON) is required', code: 'required' })
    } else {
      const parsed = parseJsonObject(spec.credentialJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.credential_json`, message: `Account ${parsed.error}`, code: 'invalid_json' })
      }
    }

    if (!spec.secret) {
      errors.push({ field: `${prefix}.secret`, message: 'Secret (password/key) is required', code: 'required' })
    }

    if (spec.siteName && spec.name) {
      const key = credentialKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate credential "${spec.name}" for site "${spec.siteName}" — each (site, credential name) may only be declared once`,
          code: 'duplicate_credential',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
