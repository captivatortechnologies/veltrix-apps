import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Rapid7 InsightVM Shared Scan Credentials — validate + shared spec extraction.
//
// ⚠ SECRET-BEARING config type. Each item carries a write-only `secret` (the
// account password/key). The secret is NEVER read back from the API, NEVER
// diffed, and NEVER stored in rollbackData / artifacts / logs. This module only
// checks that a secret is present — it never echoes its value.
// =============================================================================

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface CredentialSpec {
  sectionName: string
  name: string
  description: string
  /** The account object WITHOUT the secret (raw JSON textarea, e.g. {"service":"ssh",...}). */
  credentialJson: string
  /** ⚠ Write-only secret (password/key). Sent on every create AND update; never read/diffed/stored. */
  secret: string
}

/**
 * Shape of a shared credential returned by GET /shared_credentials. `account`
 * carries the non-secret account fields; the API masks `account.password` on
 * read, so we treat it as opaque and never rely on it.
 */
export interface LiveCredential {
  id?: number
  name?: string
  description?: string
  account?: Record<string, unknown>
}

/** The natural key — a shared credential's logical identity is its name. */
export function credentialKey(spec: { name: string }): string {
  return spec.name.trim().toLowerCase()
}

/**
 * Parse a JSON object field. NON-UNION { value, error } (never a discriminated
 * union — the platform loader can't narrow those).
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

/** Each canvas item describes one InsightVM shared credential. */
export function extractCredentialSpecs(canvas: CanvasSnapshot): CredentialSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      credentialJson: typeof fields.credential_json === 'string' ? fields.credential_json : '',
      // Secret is intentionally NOT trimmed of interior characters, only surrounding whitespace,
      // and is never logged or surfaced in any error/diff message.
      secret: typeof fields.secret === 'string' ? fields.secret.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate shared credential configurations: a name, credential JSON and secret
 * are required, the credential JSON parses to an object (the account without the
 * secret), and the name is unique across the canvas. The secret's value is never
 * inspected beyond a presence check.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCredentialSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Credential name is required', code: 'required' })
    }
    if (!spec.credentialJson.trim()) {
      errors.push({ field: `${prefix}.credential_json`, message: 'Credential account JSON is required', code: 'required' })
    } else {
      const parsed = parseJsonObject(spec.credentialJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.credential_json`, message: `Credential account ${parsed.error}`, code: 'invalid_json' })
      }
    }
    if (!spec.secret) {
      // Only the absence of the secret is reported — never its value.
      errors.push({ field: `${prefix}.secret`, message: 'Secret (password/key) is required', code: 'required' })
    }

    if (spec.name) {
      const key = credentialKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate credential "${spec.name}" — each credential name may only be declared once`,
          code: 'duplicate_credential',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
