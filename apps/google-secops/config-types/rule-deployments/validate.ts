import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps rule deployment constraints -------------------------------

/** The run frequencies a YARA-L 2 rule can execute at (RunFrequency enum). */
export const RUN_FREQUENCIES = ['LIVE', 'HOURLY', 'DAILY'] as const

export interface RuleDeploymentSpec {
  itemId?: string
  /** ruleName = the rule's displayName — the identity used to resolve the rule. */
  ruleName: string
  /** Whether the rule runs continuously against incoming data. */
  enabled: boolean
  /** Whether detections from this deployment are treated as alerts. */
  alerting: boolean
  /** One of RUN_FREQUENCIES. */
  runFrequency: string
}

/** A rule deployment as returned by the SecOps API (`{parent}/rules/{ruleId}/deployment`). */
export interface LiveRuleDeployment {
  name?: string
  enabled?: boolean
  alerting?: boolean
  archived?: boolean
  runFrequency?: string
  executionState?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true
}

export function extractRuleDeploymentSpecs(canvas: CanvasSnapshot): RuleDeploymentSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      ruleName: asString(f.ruleName) || item.name,
      enabled: asBool(f.enabled),
      alerting: asBool(f.alerting),
      runFrequency: (asString(f.runFrequency) || 'LIVE').toUpperCase(),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRuleDeploymentSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.ruleName`, message: 'Rule name is required — it must match the displayName of an existing detection rule', code: 'required' })
    } else {
      const key = spec.ruleName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.ruleName`, message: `Duplicate rule deployment "${spec.ruleName}"`, code: 'duplicate_rule' })
      }
      seenNames.add(key)
    }

    if (!(RUN_FREQUENCIES as readonly string[]).includes(spec.runFrequency)) {
      errors.push({ field: `${prefix}.runFrequency`, message: `Run frequency must be one of: ${RUN_FREQUENCIES.join(', ')}`, code: 'invalid_run_frequency' })
    }

    if (spec.alerting && !spec.enabled) {
      warnings.push({ field: `${prefix}.alerting`, message: 'Alerting has no effect while the rule is not enabled — an unenabled rule produces no detections', code: 'alerting_without_enabled' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
