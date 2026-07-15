import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Web DLP Rules constraints -------------------------------------------

/** Default evaluation order applied when the order field is left blank. */
export const DEFAULT_RULE_ORDER = 1
/** Default protocol applied when the protocols field is left blank. */
export const DEFAULT_PROTOCOL = 'ANY_RULE'
/** Web DLP rule state values. */
export const RULE_STATES = ['ENABLED', 'DISABLED'] as const
/** Web DLP rule action values. */
export const RULE_ACTIONS = ['ALLOW', 'BLOCK', 'CONFIRM'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface WebDlpRuleSpec {
  sectionName: string
  /** The rule name — its logical identity (list + match). */
  name: string
  /** Evaluation order; undefined when blank, NaN when set to a non-number. */
  order?: number
  /** Rule state (ENABLED | DISABLED); defaulted during extraction. */
  state: string
  /** Rule action (ALLOW | BLOCK | CONFIRM); defaulted during extraction. */
  action: string
  /** Protocols the rule applies to; defaults to [ANY_RULE] when blank. */
  protocols: string[]
  /** Raw JSON escape hatch for advanced criteria; absent/blank = minimal rule. */
  ruleJson?: string
}

/** Shape of a web DLP rule returned by GET /webDlpRules. */
export interface LiveWebDlpRule {
  id?: number
  name?: string
  order?: number
  rank?: number
  state?: string
  action?: string
  protocols?: string[]
  /** ZIA marks the built-in catch-all rule with one of these flags. */
  isDefaultRule?: boolean
  defaultRule?: boolean
  predefined?: boolean
}

/**
 * A web DLP rule is PROTECTED when it is the built-in default (catch-all) rule.
 * ZIA marks it with `isDefaultRule`/`defaultRule` (or `predefined`); it must
 * never be updated or deleted, so deploy throws when a declared name matches it.
 */
export function isProtectedDefaultRule(rule: LiveWebDlpRule): boolean {
  return rule.isDefaultRule === true || rule.defaultRule === true || rule.predefined === true
}

/**
 * Parse the raw rule_json escape-hatch string, returning the object or null when
 * the string is not a JSON object (a JSON array or primitive counts as invalid
 * too). Shared by validate (to reject bad input) and deploy (to build the body).
 */
export function parseRuleObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/**
 * Parse a canvas order field. Returns undefined when blank/absent, NaN when
 * present but not a finite number (so validate can reject it), else the number.
 */
export function toOptionalOrder(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : NaN
  }
  return NaN
}

/** Split a textarea value into trimmed, non-blank lines. */
function toLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one ZIA web DLP rule. */
export function extractWebDlpRuleSpecs(canvas: CanvasSnapshot): WebDlpRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const state =
      typeof fields.state === 'string' && fields.state.trim()
        ? fields.state.trim().toUpperCase()
        : 'ENABLED'
    const action =
      typeof fields.action === 'string' && fields.action.trim()
        ? fields.action.trim().toUpperCase()
        : 'BLOCK'
    const protocols = toLines(fields.protocols)
    const ruleJson =
      typeof fields.rule_json === 'string' && fields.rule_json.trim()
        ? fields.rule_json.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      order: toOptionalOrder(fields.order),
      state,
      action,
      // A rule with no protocols would never match; default to ANY_RULE.
      protocols: protocols.length > 0 ? protocols : [DEFAULT_PROTOCOL],
      ruleJson,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate web DLP rule configurations against ZIA constraints: a name is
 * required and — a rule's logical identity — must be unique across the canvas
 * (matched case-insensitively, since ZIA rejects rules differing only in case);
 * the order, when set, must be a positive integer; and the rule_json escape
 * hatch, when present, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractWebDlpRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required and unique (case-insensitive).
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Web DLP rule name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate web DLP rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_web_dlp_rule',
        })
      }
      seen.add(key)
    }

    // order — optional; when set it must be a positive integer.
    if (spec.order !== undefined && !(Number.isInteger(spec.order) && spec.order >= 1)) {
      errors.push({
        field: `${prefix}.order`,
        message: 'Order must be a positive integer (1 or greater)',
        code: 'invalid_order',
      })
    }

    // rule_json — optional; when present it must parse as a JSON object.
    if (spec.ruleJson && parseRuleObject(spec.ruleJson) === null) {
      errors.push({
        field: `${prefix}.rule_json`,
        message:
          'Advanced Criteria must be a valid JSON object, e.g. {"dlpEngines":[{"id":42}]} — leave blank for a minimal rule',
        code: 'invalid_rule_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
