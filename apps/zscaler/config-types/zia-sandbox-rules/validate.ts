import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Sandbox Rules constraints -------------------------------------------

/** ZIA caps a policy rule name at 255 characters. */
export const MAX_RULE_NAME_LENGTH = 255
/** Default evaluation order when the author leaves the order field blank. */
export const DEFAULT_ORDER = 1
/** Default rule state when the author leaves the state field blank. */
export const DEFAULT_STATE = 'ENABLED'
/** Valid rule states. */
export const RULE_STATES = ['ENABLED', 'DISABLED'] as const

// --- rule_json escape hatch ---------------------------------------------------

/**
 * Result of parsing the `rule_json` escape hatch. A sandbox rule keeps only
 * name / order / state as first-class fields; everything type-specific (the
 * Sandbox action `ba_rule_action`, `ba_policy_categories`, `fileTypes`, …) is
 * authored as a single JSON object that deploy merges into the request body.
 */
export interface ParsedRuleJson {
  /** True when a non-blank rule_json value was supplied. */
  present: boolean
  /** True when rule_json was supplied but did not parse to a JSON object. */
  invalid: boolean
  /** The parsed object, when present and valid. */
  value?: Record<string, unknown>
}

/**
 * Parse the `rule_json` textarea into a plain JSON object. Blank is allowed
 * (no advanced criteria); anything present must parse to a non-array object.
 * Never throws — validate reports `invalid`, deploy relies on `value`.
 */
export function parseRuleObject(raw: unknown): ParsedRuleJson {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { present: false, invalid: false }
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { present: true, invalid: false, value: parsed as Record<string, unknown> }
    }
    return { present: true, invalid: true }
  } catch {
    return { present: true, invalid: true }
  }
}

/**
 * Parse the `order` field. Blank falls back to the default; a supplied value
 * must be a positive integer (ZIA orders rules from 1). `invalid` is surfaced
 * by validate so a bad value is rejected rather than silently defaulted.
 */
export function parseOrder(raw: unknown): { order: number; invalid: boolean } {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { order: DEFAULT_ORDER, invalid: false }
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (Number.isInteger(n) && n > 0) return { order: n, invalid: false }
  return { order: DEFAULT_ORDER, invalid: true }
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SandboxRuleSpec {
  sectionName: string
  /** The sandbox rule name — its logical identity (list + match). */
  name: string
  /** 1-based evaluation order; defaults to 1 when unset. */
  order: number
  /** True when the order field held a value that is not a positive integer. */
  orderInvalid: boolean
  /** ENABLED | DISABLED; defaults to ENABLED. */
  state: string
  /** Parsed rule_json escape-hatch object (Sandbox action + advanced criteria). */
  ruleJson?: Record<string, unknown>
  /** True when rule_json was supplied but is not a JSON object. */
  ruleJsonInvalid: boolean
}

/** Shape of a sandbox rule returned by GET /sandboxRules. */
export interface LiveSandboxRule {
  id?: number
  name?: string
  order?: number
  rank?: number
  state?: string
  /** Marks the built-in default rule — read-only, never modified or deleted. */
  defaultRule?: boolean
  isDefaultRule?: boolean
  predefined?: boolean
  /** The Sandbox action, carried inside the JSON body. */
  ba_rule_action?: string
  [key: string]: unknown
}

/** Each canvas item describes one ZIA sandbox rule. */
export function extractSandboxRuleSpecs(canvas: CanvasSnapshot): SandboxRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const { order, invalid: orderInvalid } = parseOrder(fields.order)
    const rawState = typeof fields.state === 'string' ? fields.state.trim().toUpperCase() : ''
    const state = rawState === 'DISABLED' ? 'DISABLED' : DEFAULT_STATE
    const rule = parseRuleObject(fields.rule_json)
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      order,
      orderInvalid,
      state,
      ruleJson: rule.value,
      ruleJsonInvalid: rule.invalid,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate sandbox rule configurations against ZIA constraints: a name is
 * required, capped at 255 chars, and unique across the canvas (case-insensitive,
 * since ZIA rejects rules differing only in case). Order must be a positive
 * integer when supplied, and the `rule_json` escape hatch — when present — must
 * parse to a JSON object (its Sandbox action / criteria are not otherwise
 * inspected here).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSandboxRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Sandbox rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Sandbox rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate sandbox rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_sandbox_rule',
        })
      }
      seen.add(key)
    }

    if (spec.orderInvalid) {
      errors.push({
        field: `${prefix}.order`,
        message: 'Order must be a positive integer (rules are evaluated from 1)',
        code: 'invalid_order',
      })
    }

    if (spec.ruleJsonInvalid) {
      errors.push({
        field: `${prefix}.rule_json`,
        message: 'Rule JSON must be a valid JSON object (e.g. {"ba_rule_action": "BLOCK"})',
        code: 'invalid_rule_json',
      })
    } else if (!spec.ruleJson || spec.ruleJson.ba_rule_action === undefined) {
      // The Sandbox action is not first-class — warn (do not fail) when the
      // escape hatch omits it, so the author notices before the rule is created
      // with the tenant's implicit default action.
      warnings.push({
        field: `${prefix}.rule_json`,
        message: 'No "ba_rule_action" set in Rule JSON — the sandbox rule will use the tenant default action',
        code: 'missing_action',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
