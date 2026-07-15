import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Rulesets — rate limiting rules --------------------------------

/** The Rulesets phase this config type owns. */
export const PHASE = 'http_ratelimit'

export const ACTIONS = ['block', 'managed_challenge', 'js_challenge', 'challenge', 'log'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RateLimitRuleSpec {
  sectionName: string
  name: string
  /** Stable external identifier derived from the name — the reconciliation key. */
  ref: string
  action: string
  expression: string
  enabled: boolean
  ratelimitJson: string
}

/** Shape of a ruleset-engine rule returned by the API. */
export interface LiveRule {
  id?: string
  ref?: string
  action?: string
  expression?: string
  description?: string
  enabled?: boolean
  ratelimit?: Record<string, unknown>
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * Result of parsing ratelimit_json. NOT a discriminated union — the platform's
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

/** Each canvas item describes one rate limiting rule, in evaluation order. */
export function extractRateLimitRuleSpecs(canvas: CanvasSnapshot): RateLimitRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    return {
      sectionName: section.name,
      name,
      ref: slugRef(name),
      action: typeof fields.action === 'string' ? fields.action.trim() : 'block',
      expression: typeof fields.expression === 'string' ? fields.expression.trim() : '',
      enabled: readBool(fields.enabled, true),
      ratelimitJson: typeof fields.ratelimit_json === 'string' ? fields.ratelimit_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate rate limiting rule configurations: a name (→ ref) is required and
 * unique across the canvas, the action must be supported, an expression is
 * required, and ratelimit_json is required and must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRateLimitRuleSpecs(ctx.canvas)
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

    if (!spec.action || !ACTIONS.includes(spec.action as (typeof ACTIONS)[number])) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}"`, code: 'invalid_action' })
    }
    if (!spec.expression) {
      errors.push({ field: `${prefix}.expression`, message: 'Rule expression is required', code: 'required' })
    }
    if (!spec.ratelimitJson.trim()) {
      errors.push({ field: `${prefix}.ratelimit_json`, message: 'Rate limit parameters are required', code: 'required' })
    } else {
      const parsed = parseJsonObject(spec.ratelimitJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.ratelimit_json`, message: `Rate limit parameters ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
