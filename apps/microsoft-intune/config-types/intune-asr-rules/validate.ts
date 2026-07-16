import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { ASR_RULES, configuredRuleCount, normalizeState, type AsrPolicySpec, type AsrState } from '../../lib/asr'

/** Read a tags/list field into a trimmed string array (accepts a comma string too). */
function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** The policy name is the reconciliation key. */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item is one ASR policy: a name + the 19 rule states + optional exclusions. */
export function extractAsrSpecs(canvas: CanvasSnapshot): AsrPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rules: Record<string, AsrState> = {}
    for (const rule of ASR_RULES) rules[rule.key] = normalizeState(fields[rule.key])
    return {
      sectionName: section.name,
      name: typeof fields.policy_name === 'string' ? fields.policy_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      rules,
      exclusions: readList(fields.exclusions),
    }
  })
}

/**
 * Validate ASR rule policies: each needs a name (unique across the canvas) and at
 * least one configured rule (a policy with every rule "Not configured" and no
 * rules is rejected — Intune requires the ASR-rules group to carry ≥1 rule).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no ASR policy items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAsrSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.policy_name`, message: 'Policy name is required', code: 'required' })
    } else {
      const key = policyKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.policy_name`, message: `Duplicate policy name "${spec.name}"`, code: 'duplicate_policy' })
      }
      seen.add(key)
    }

    if (configuredRuleCount(spec) === 0) {
      errors.push({
        field: `${prefix}.rules`,
        message: 'Configure at least one ASR rule (Off / Block / Audit / Warn) — a policy with no rules is rejected by Intune',
        code: 'no_rules_configured',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
