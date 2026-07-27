import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps detection rule constraints --------------------------------

/** The `rule <name> { ... }` header — its name is the rule's identity (Chronicle echoes it as displayName). */
const RULE_NAME_RE = /\brule\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/
/** YARA-L 2.0 rules must declare a condition section. */
const CONDITION_RE = /\bcondition\s*:/

export interface RuleSpec {
  itemId?: string
  /** ruleName = the `rule <name>` name parsed from the text — the identity. */
  ruleName: string
  text: string
}

/** A rule as returned by the SecOps API. `name` is `{parent}/rules/{ruleId}`. */
export interface LiveRule {
  name?: string
  displayName?: string
  text?: string
  revisionId?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse the rule name out of the YARA-L source, or '' when the header is absent. */
export function extractRuleName(text: string): string {
  return RULE_NAME_RE.exec(text)?.[1] ?? ''
}

/** Collapse whitespace so cosmetic re-formatting (indentation, line wrapping) is not read as a change. */
export function normalizeRuleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function extractRuleSpecs(canvas: CanvasSnapshot): RuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const text = asString(item.fields?.text)
    return { itemId: item.id, ruleName: extractRuleName(text), text }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.text) {
      errors.push({ field: `${prefix}.text`, message: 'Rule text is required', code: 'required' })
      return
    }

    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.text`, message: 'Could not find a `rule <name> { ... }` declaration in the rule text', code: 'no_rule_name' })
    } else {
      const key = spec.ruleName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.text`, message: `Duplicate rule "${spec.ruleName}"`, code: 'duplicate_rule' })
      }
      seenNames.add(key)
    }

    if (!CONDITION_RE.test(spec.text)) {
      errors.push({ field: `${prefix}.text`, message: 'Rule text must contain a `condition:` section', code: 'no_condition' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
