import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Access — reusable Access groups (account-scoped) --------------
//
// An Access group is a named, reusable bundle of rules referenced by Access
// policies. It lives under /accounts/{account_id}/access/groups and is keyed by
// its `name` (the reconciliation identity). Its rule sets — include / exclude /
// require — are JSON ARRAYS of Cloudflare rule objects, e.g.
//   [{"email":{"email":"user@example.com"}}, {"email_domain":{"domain":"acme.com"}}]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AccessGroupSpec {
  sectionName: string
  name: string
  /** Raw JSON text for the include rule array (required, must be a non-empty array). */
  includeJson: string
  /** Raw JSON text for the optional exclude rule array. */
  excludeJson: string
  /** Raw JSON text for the optional require rule array. */
  requireJson: string
}

/** Shape of an Access group returned by GET /access/groups. */
export interface LiveAccessGroup {
  id?: string
  name?: string
  include?: unknown[]
  exclude?: unknown[]
  require?: unknown[]
}

/**
 * Result of parsing a JSON-array field. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `value` and `error` are always-present nullable fields. A blank input is a
 * valid empty array (callers enforce non-emptiness where required).
 */
export interface JsonArrayParseResult {
  value: unknown[] | null
  error: string | null
}

export function parseJsonArray(raw: string | undefined): JsonArrayParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON array' }
  }
  return { value: parsed, error: null }
}

/** Each canvas item describes one reusable Access group. */
export function extractAccessGroupSpecs(canvas: CanvasSnapshot): AccessGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      includeJson: typeof fields.include_json === 'string' ? fields.include_json : '',
      excludeJson: typeof fields.exclude_json === 'string' ? fields.exclude_json : '',
      requireJson: typeof fields.require_json === 'string' ? fields.require_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Access group configurations: a name is required and unique across the
 * canvas (its identity), the include rules are required and must parse to a
 * NON-EMPTY JSON array, and the optional exclude / require rules must parse to a
 * JSON array when present.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAccessGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
    } else {
      if (seen.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group name "${spec.name}" — each Access group must be uniquely named`,
          code: 'duplicate_group',
        })
      }
      seen.add(spec.name)
    }

    // include_json is required and must parse to a NON-EMPTY array.
    if (!spec.includeJson.trim()) {
      errors.push({ field: `${prefix}.include_json`, message: 'Include rules (a JSON array) are required', code: 'required' })
    } else {
      const parsed = parseJsonArray(spec.includeJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.include_json`, message: `Include rules ${parsed.error}`, code: 'invalid_json' })
      } else if (!parsed.value || parsed.value.length === 0) {
        errors.push({ field: `${prefix}.include_json`, message: 'Include rules must be a non-empty JSON array', code: 'invalid_json' })
      }
    }

    // exclude_json / require_json are optional; when present they must be arrays.
    if (spec.excludeJson.trim()) {
      const parsed = parseJsonArray(spec.excludeJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.exclude_json`, message: `Exclude rules ${parsed.error}`, code: 'invalid_json' })
      }
    }
    if (spec.requireJson.trim()) {
      const parsed = parseJsonArray(spec.requireJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.require_json`, message: `Require rules ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
