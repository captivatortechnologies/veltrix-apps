import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Access policies -----------------------------------------------

/** Supported reusable-policy decisions. */
export const DECISIONS = ['allow', 'deny', 'bypass', 'non_identity'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AccessPolicySpec {
  sectionName: string
  name: string
  decision: string
  includeJson: string
  requireJson: string
  excludeJson: string
}

/** Shape of a reusable Access policy returned by GET /access/policies. */
export interface LiveAccessPolicy {
  id?: string
  name?: string
  decision?: string
  include?: unknown[]
  require?: unknown[]
  exclude?: unknown[]
}

/**
 * Result of parsing a JSON-array textarea field. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `value` and `error` are always-present nullable fields. A blank field is an
 * empty array with no error; a non-array (object, string, number, …) is an error.
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

/** Each canvas item describes one reusable Access policy. */
export function extractAccessPolicySpecs(canvas: CanvasSnapshot): AccessPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      decision: typeof fields.decision === 'string' ? fields.decision.trim() : 'allow',
      includeJson: typeof fields.include_json === 'string' ? fields.include_json : '',
      requireJson: typeof fields.require_json === 'string' ? fields.require_json : '',
      excludeJson: typeof fields.exclude_json === 'string' ? fields.exclude_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Access policy configurations: a name is required and unique across the
 * canvas; the decision must be supported; include_json is required and must parse
 * to a non-empty JSON array; and require_json / exclude_json (when present) must
 * each parse to a JSON array.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAccessPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else if (seen.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate Access policy "${spec.name}" — each policy must be uniquely named`,
        code: 'duplicate_policy',
      })
    }
    if (spec.name) seen.add(spec.name)

    if (!spec.decision || !DECISIONS.includes(spec.decision as (typeof DECISIONS)[number])) {
      errors.push({ field: `${prefix}.decision`, message: `Unsupported decision "${spec.decision}"`, code: 'invalid_decision' })
    }

    // include_json is required and must be a non-empty JSON array.
    if (!spec.includeJson.trim()) {
      errors.push({ field: `${prefix}.include_json`, message: 'Include rules (JSON array) are required', code: 'required' })
    } else {
      const parsed = parseJsonArray(spec.includeJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.include_json`, message: `Include rules ${parsed.error}`, code: 'invalid_json' })
      } else if (!parsed.value || parsed.value.length === 0) {
        errors.push({ field: `${prefix}.include_json`, message: 'Include rules must be a non-empty JSON array', code: 'invalid_json' })
      }
    }

    // require_json / exclude_json are optional but must be JSON arrays if present.
    if (spec.requireJson.trim()) {
      const parsed = parseJsonArray(spec.requireJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.require_json`, message: `Require rules ${parsed.error}`, code: 'invalid_json' })
      }
    }
    if (spec.excludeJson.trim()) {
      const parsed = parseJsonArray(spec.excludeJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.exclude_json`, message: `Exclude rules ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
