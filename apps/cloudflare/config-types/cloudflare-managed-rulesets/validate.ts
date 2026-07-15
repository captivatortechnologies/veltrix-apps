import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare Rulesets — managed rulesets -----------------------------------
//
// Each item deploys/overrides ONE Cloudflare-managed ruleset into the zone's
// http_request_firewall_managed phase via an `execute` rule. The action is fixed
// to `execute`. IMPORTANT: a Cloudflare-managed ruleset is READ-ONLY — this
// config type never edits the managed rules themselves; it only deploys the
// managed ruleset and optionally applies overrides on top of it.

/** The Rulesets phase this config type owns. */
export const PHASE = 'http_request_firewall_managed'

/** Managed-ruleset deployments are always `execute` rules. */
export const ACTION = 'execute'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ManagedRulesetSpec {
  sectionName: string
  name: string
  /** Stable external identifier derived from the name — the reconciliation key. */
  ref: string
  /** Id of the Cloudflare-managed ruleset to deploy (read-only ruleset). */
  managedRulesetId: string
  expression: string
  enabled: boolean
  overridesJson: string
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
 * Result of parsing overrides_json. NOT a discriminated union — the platform's
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

/** Each canvas item describes one managed-ruleset deployment, in evaluation order. */
export function extractManagedRulesetSpecs(canvas: CanvasSnapshot): ManagedRulesetSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    return {
      sectionName: section.name,
      name,
      ref: slugRef(name),
      managedRulesetId: typeof fields.managed_ruleset_id === 'string' ? fields.managed_ruleset_id.trim() : '',
      expression: typeof fields.expression === 'string' ? fields.expression.trim() : '',
      enabled: readBool(fields.enabled, true),
      overridesJson: typeof fields.overrides_json === 'string' ? fields.overrides_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate managed-ruleset configurations: a name (→ ref) is required and unique
 * across the canvas, a managed ruleset id is required, and overrides_json (when
 * present) must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractManagedRulesetSpecs(ctx.canvas)
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

    if (!spec.managedRulesetId) {
      errors.push({ field: `${prefix}.managed_ruleset_id`, message: 'Managed ruleset id is required', code: 'required' })
    }

    if (spec.overridesJson.trim()) {
      const parsed = parseJsonObject(spec.overridesJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.overrides_json`, message: `Overrides ${parsed.error}`, code: 'invalid_json' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
