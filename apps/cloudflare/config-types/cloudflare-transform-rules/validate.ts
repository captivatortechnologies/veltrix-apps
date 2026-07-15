import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Rulesets — Transform Rules (multi-phase) -----------------------
//
// One config type, three phases. A transform rule targets one of three Rulesets
// phases depending on its `transform_type`; all three share the `rewrite` action
// and an `action_parameters` payload. A single canvas can mix transform types, so
// deploy/rollback/drift/health are all phase-aware: specs are grouped by the phase
// their transform_type maps to, and each phase entrypoint is owned declaratively.

/** transform_type → the Rulesets phase entrypoint it owns. */
export const TRANSFORM_TYPES = ['url_rewrite', 'request_headers', 'response_headers'] as const
export type TransformType = (typeof TRANSFORM_TYPES)[number]

export const TRANSFORM_TYPE_PHASE: Record<TransformType, string> = {
  url_rewrite: 'http_request_transform',
  request_headers: 'http_request_late_transform',
  response_headers: 'http_response_headers_transform',
}

/** Every rule in this config type uses the same ruleset action. */
export const RULE_ACTION = 'rewrite'

/** Resolve a transform_type to its phase, or null when the type is unknown. */
export function phaseFor(transformType: string): string | null {
  return (TRANSFORM_TYPE_PHASE as Record<string, string>)[transformType] ?? null
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface TransformRuleSpec {
  sectionName: string
  name: string
  /** Stable external identifier derived from the name — the reconciliation key. */
  ref: string
  /** The selected transform type (validated against TRANSFORM_TYPES). */
  transformType: string
  /** The phase the transform_type maps to, or null when the type is invalid. */
  phase: string | null
  expression: string
  enabled: boolean
  transformJson: string
}

/** Shape of a ruleset-engine rule returned by the API. */
export interface LiveRule {
  id?: string
  ref?: string
  action?: string
  expression?: string
  description?: string
  enabled?: boolean
  action_parameters?: Record<string, unknown>
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * Result of parsing transform_json. NOT a discriminated union — the platform's
 * handler loader does not narrow `{ ok:true } | { ok:false }`, so `value` and
 * `error` are always-present nullable fields.
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

/** Derive a stable, unique-per-ruleset `ref` slug from a rule name. */
export function slugRef(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug || 'rule'
}

/** Each canvas item describes one transform rule, targeting one phase. */
export function extractTransformRuleSpecs(canvas: CanvasSnapshot): TransformRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const transformType =
      typeof fields.transform_type === 'string' && fields.transform_type.trim()
        ? fields.transform_type.trim()
        : 'url_rewrite'
    return {
      sectionName: section.name,
      name,
      ref: slugRef(name),
      transformType,
      phase: phaseFor(transformType),
      expression: typeof fields.expression === 'string' ? fields.expression.trim() : '',
      enabled: readBool(fields.enabled, true),
      transformJson: typeof fields.transform_json === 'string' ? fields.transform_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate transform rule configurations: a name (→ ref) is required and unique
 * across the canvas, the transform type must be one of the three supported types,
 * an expression is required, and transform_json is required and must parse to a
 * JSON object (the rule's action_parameters).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTransformRuleSpecs(ctx.canvas)
  const seenRefs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else if (seenRefs.has(spec.ref)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate rule ref "${spec.ref}" (derived from the name) — each rule must be uniquely named`,
        code: 'duplicate_rule',
      })
    }
    seenRefs.add(spec.ref)

    if (!TRANSFORM_TYPES.includes(spec.transformType as TransformType)) {
      errors.push({
        field: `${prefix}.transform_type`,
        message: `Unsupported transform type "${spec.transformType}" — expected one of ${TRANSFORM_TYPES.join(', ')}`,
        code: 'invalid_transform_type',
      })
    }

    if (!spec.expression) {
      errors.push({ field: `${prefix}.expression`, message: 'Rule expression is required', code: 'required' })
    }

    if (!spec.transformJson.trim()) {
      errors.push({ field: `${prefix}.transform_json`, message: 'Transform parameters JSON is required', code: 'required' })
    } else {
      const parsed = parseJsonObject(spec.transformJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.transform_json`, message: `Transform parameters ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
