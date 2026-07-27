import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps curated rule set deployment constraints -------------------
// Google owns the curated rule set content; only the deployment STATE is
// configurable (like the existing rule-deployments type). A deployment is keyed
// by category + rule set + precision and is never created or deleted.

export const PRECISIONS = ['broad', 'precise'] as const

export interface CuratedDeploymentSpec {
  itemId?: string
  /** The curated rule set CATEGORY id (a Google-defined UUID). */
  category: string
  /** The curated RULE SET id (a Google-defined UUID). */
  ruleSet: string
  /** broad | precise. */
  precision: string
  enabled: boolean
  alerting: boolean
}

/** A curated rule set deployment as returned by the SecOps API. */
export interface LiveCuratedDeployment {
  name?: string
  enabled?: boolean
  alerting?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true
}

export function extractCuratedDeploymentSpecs(canvas: CanvasSnapshot): CuratedDeploymentSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      category: asString(f.category),
      ruleSet: asString(f.ruleSet),
      precision: (asString(f.precision) || 'broad').toLowerCase(),
      enabled: asBool(f.enabled),
      alerting: asBool(f.alerting),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCuratedDeploymentSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.category) {
      errors.push({ field: `${prefix}.category`, message: 'Curated rule set category id is required', code: 'required' })
    }
    if (!spec.ruleSet) {
      errors.push({ field: `${prefix}.ruleSet`, message: 'Curated rule set id is required', code: 'required' })
    }
    if (!(PRECISIONS as readonly string[]).includes(spec.precision)) {
      errors.push({ field: `${prefix}.precision`, message: `Precision must be one of: ${PRECISIONS.join(', ')}`, code: 'invalid_precision' })
    }

    if (spec.category && spec.ruleSet) {
      const key = `${spec.category.toLowerCase()} ${spec.ruleSet.toLowerCase()} ${spec.precision}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.ruleSet`, message: `Duplicate curated deployment for ${spec.category}/${spec.ruleSet}/${spec.precision}`, code: 'duplicate' })
      }
      seen.add(key)
    }

    if (spec.alerting && !spec.enabled) {
      warnings.push({ field: `${prefix}.alerting`, message: 'Alerting has no effect while the rule set is not enabled', code: 'alerting_without_enabled' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
