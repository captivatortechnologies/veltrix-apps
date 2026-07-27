import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black policy rule-config constraints -----------------------------
//
// SCOPE: this manages the `core_prevention` rule-config category only. It is the
// one category with a cleanly grounded contract: PUT .../rule_configs/core_prevention
// with an array of { id, parameters: { WindowsAssignmentMode }, exclusions } and a
// DELETE that resets the category to the TAU-recommended default. The other
// categories (bypass / data_collection / host_based_firewall) carry divergent,
// category-specific parameter/body shapes that vary per policy and are OUT OF
// SCOPE here (they require the live /parameters/schema to model safely).

export const RULE_CONFIG_CATEGORY = 'core_prevention'
/** The assignment mode a core-prevention rule config runs in. */
export const ASSIGNMENT_MODES = ['BLOCK', 'REPORT'] as const

export interface RuleConfigSpec {
  itemId?: string
  /** policyName — resolved to a policy_id; the rule config is nested under it. */
  policyName: string
  /** the WindowsAssignmentMode applied to the policy's core-prevention configs. */
  assignmentMode: string
  /** optional exclusions object (validated JSON) applied to each config. */
  exclusions: Record<string, unknown> | null
  /** the raw exclusions textarea, kept so validate can report parse errors. */
  exclusionsRaw: string
}

/** A rule config as returned by GET .../rule_configs. */
export interface LiveRuleConfig {
  id?: string
  name?: string
  description?: string
  category?: string
  parameters?: { WindowsAssignmentMode?: string } & Record<string, unknown>
  exclusions?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parseExclusions(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

export function extractRuleConfigSpecs(canvas: CanvasSnapshot): RuleConfigSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const raw = (typeof f.exclusionsJson === 'string' ? f.exclusionsJson : '').trim()
    return {
      itemId: item.id,
      policyName: asString(f.policyName) || item.name,
      assignmentMode: (asString(f.assignmentMode) || 'BLOCK').toUpperCase(),
      exclusions: parseExclusions(raw),
      exclusionsRaw: raw,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRuleConfigSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.policyName) {
      errors.push({ field: `${prefix}.policyName`, message: 'Policy name is required', code: 'required' })
    } else {
      const key = spec.policyName.toLowerCase()
      // One core-prevention rule-config item per policy.
      if (seen.has(key)) errors.push({ field: `${prefix}.policyName`, message: `Duplicate rule config for policy "${spec.policyName}"`, code: 'duplicate_policy' })
      seen.add(key)
    }

    if (!(ASSIGNMENT_MODES as readonly string[]).includes(spec.assignmentMode)) {
      errors.push({ field: `${prefix}.assignmentMode`, message: `Assignment mode must be one of: ${ASSIGNMENT_MODES.join(', ')}`, code: 'invalid_mode' })
    }

    if (spec.exclusionsRaw && !spec.exclusions) {
      errors.push({ field: `${prefix}.exclusionsJson`, message: 'Exclusions must be a valid JSON object', code: 'invalid_json' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
