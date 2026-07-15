import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Rulesets — dynamic redirect rules -----------------------------

/** The Rulesets phase this config type owns. */
export const PHASE = 'http_request_dynamic_redirect'

/** The action is fixed for this phase — every rule is a redirect. */
export const ACTION = 'redirect'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RedirectRuleSpec {
  sectionName: string
  name: string
  /** Stable external identifier derived from the name — the reconciliation key. */
  ref: string
  expression: string
  enabled: boolean
  redirectJson: string
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
 * Result of parsing redirect_json. NOT a discriminated union — the platform's
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

/** Each canvas item describes one redirect rule, in evaluation order. */
export function extractRedirectRuleSpecs(canvas: CanvasSnapshot): RedirectRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    return {
      sectionName: section.name,
      name,
      ref: slugRef(name),
      expression: typeof fields.expression === 'string' ? fields.expression.trim() : '',
      enabled: readBool(fields.enabled, true),
      redirectJson: typeof fields.redirect_json === 'string' ? fields.redirect_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate redirect rule configurations: a name (→ ref) is required and unique
 * across the canvas, an expression is required, and redirect_json is required and
 * must parse to a JSON object (the action's from_value).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRedirectRuleSpecs(ctx.canvas)
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

    if (!spec.expression) {
      errors.push({ field: `${prefix}.expression`, message: 'Rule expression is required', code: 'required' })
    }

    if (!spec.redirectJson.trim()) {
      errors.push({ field: `${prefix}.redirect_json`, message: 'Redirect (from_value JSON) is required', code: 'required' })
    } else {
      const parsed = parseJsonObject(spec.redirectJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.redirect_json`, message: `Redirect ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
