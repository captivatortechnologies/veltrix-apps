import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Scope types accepted by the console v3 API's PolicyOverrideScope. `all-assets`
 * overrides the rule's result for every asset it applies to; the other two target
 * one asset (optionally only until that asset's next scan).
 */
export const SCOPE_TYPES = ['all-assets', 'specific-asset', 'specific-asset-until-next-scan'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface OverrideSpec {
  sectionName: string
  ruleId: number | undefined
  scopeType: string
  /** Required unless scopeType is all-assets. */
  assetId: number | undefined
  newResult: string
  originalResult: string
  /** Optional ISO-8601 expiration date/time. */
  expires: string
}

/** Shape of a policy override returned by GET /policy_overrides. */
export interface LiveOverride {
  id?: number
  scope?: {
    type?: string
    rule?: number
    asset?: number
    new_result?: string
    original_result?: string
  }
  expires?: string
  state?: string
}

/**
 * The (rule, scope type, asset) natural key — an override's logical identity.
 * `all-assets` overrides carry no asset component.
 */
export function overrideKey(spec: { ruleId: number; scopeType: string; assetId: number | undefined }): string {
  return JSON.stringify([spec.ruleId, spec.scopeType, spec.scopeType === 'all-assets' ? '' : (spec.assetId ?? '')])
}

/** Build the natural key from a live override, or null when it lacks identity. */
export function liveOverrideKey(live: LiveOverride): string | null {
  const scope = live.scope
  if (!scope || scope.rule == null || !scope.type) return null
  return overrideKey({ ruleId: scope.rule, scopeType: scope.type, assetId: scope.asset })
}

/** A human-readable label for an override, e.g. `rule 42 (specific-asset:1001)`. */
export function overrideLabel(spec: OverrideSpec): string {
  const scope = spec.scopeType === 'all-assets' ? spec.scopeType : `${spec.scopeType}:${spec.assetId ?? 'unset'}`
  return `rule ${spec.ruleId ?? 'unset'} (${scope})`
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Each canvas item describes one InsightVM policy override. */
export function extractOverrideSpecs(canvas: CanvasSnapshot): OverrideSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return {
      sectionName: section.name,
      ruleId: readNumber(fields.rule_id),
      scopeType: str(fields.scope_type) || 'specific-asset',
      assetId: readNumber(fields.asset_id),
      newResult: str(fields.new_result),
      originalResult: str(fields.original_result),
      expires: str(fields.expires),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate policy-override configurations: a numeric rule id and a new result are
 * required; the scope type is from the supported set; a non-`all-assets` scope
 * requires an asset id; and the (rule, scope type, asset) natural key is unique
 * across the canvas. An override with no expiration is flagged as a warning —
 * it is valid (the console allows overrides to persist indefinitely) but worth
 * calling out for a compliance-focused config type.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractOverrideSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (spec.ruleId === undefined) {
      errors.push({ field: `${prefix}.rule_id`, message: 'Policy rule id is required', code: 'required' })
    }

    const scopeValid = (SCOPE_TYPES as readonly string[]).includes(spec.scopeType)
    if (!scopeValid) {
      errors.push({ field: `${prefix}.scope_type`, message: `Unsupported scope type "${spec.scopeType}"`, code: 'invalid_scope_type' })
    }
    if (scopeValid && spec.scopeType !== 'all-assets' && spec.assetId === undefined) {
      errors.push({ field: `${prefix}.asset_id`, message: `A "${spec.scopeType}" scope requires an asset id`, code: 'required' })
    }

    if (!spec.newResult) {
      errors.push({ field: `${prefix}.new_result`, message: 'New result is required', code: 'required' })
    }

    if (!spec.expires) {
      warnings.push({
        field: `${prefix}.expires`,
        message: 'No expiration set — this override will remain in effect indefinitely until manually recalled',
        code: 'no_expiration',
      })
    }

    if (spec.ruleId !== undefined && scopeValid) {
      const key = overrideKey({ ruleId: spec.ruleId, scopeType: spec.scopeType, assetId: spec.assetId })
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.rule_id`,
          message: `Duplicate override for ${overrideLabel(spec)} — each (rule, scope) may only be declared once`,
          code: 'duplicate_override',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
