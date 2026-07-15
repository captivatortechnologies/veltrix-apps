import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA URL Filtering Rules constraints -------------------------------------

/** ZIA caps a URL filtering rule name at 255 characters. */
export const MAX_RULE_NAME_LENGTH = 255

/** Actions ZIA accepts for a URL filtering rule. */
export const URL_FILTERING_ACTIONS = ['ALLOW', 'BLOCK', 'CAUTION', 'ISOLATE'] as const
/** Rule states ZIA accepts. */
export const RULE_STATES = ['ENABLED', 'DISABLED'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface UrlFilteringRuleSpec {
  sectionName: string
  /** The rule name — its logical identity (list + match). */
  name: string
  /** Raw order value as authored (canvas may hand this over as a number or string). */
  orderRaw: unknown
  /** ENABLED | DISABLED (first-class; defaults to ENABLED). */
  state: string
  /** ALLOW | BLOCK | CAUTION | ISOLATE (first-class; defaults to BLOCK). */
  action: string
  /** One protocol per line (e.g. ANY_RULE); deploy falls back to ["ANY_RULE"]. */
  protocols: string[]
  /** Raw rule_json escape-hatch string; absent/blank = no advanced criteria. */
  ruleJson?: string
}

/** Shape of a URL filtering rule returned by GET /urlFilteringRules. */
export interface LiveUrlFilteringRule {
  id?: number
  name?: string
  order?: number
  state?: string
  action?: string
  /** Flags marking the protected built-in default rule (any of these => read-only). */
  defaultRule?: boolean
  isDefaultRule?: boolean
  predefined?: boolean
  /** Every other server field is preserved so rollback can PUT the prior object back. */
  [key: string]: unknown
}

/** Split a textarea into trimmed, non-blank lines. */
function splitLines(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one ZIA URL filtering rule. */
export function extractUrlFilteringRuleSpecs(canvas: CanvasSnapshot): UrlFilteringRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const ruleJson =
      typeof fields.rule_json === 'string' && fields.rule_json.trim()
        ? fields.rule_json.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      orderRaw: fields.order,
      state:
        typeof fields.state === 'string' && fields.state.trim() ? fields.state.trim() : 'ENABLED',
      action:
        typeof fields.action === 'string' && fields.action.trim() ? fields.action.trim() : 'BLOCK',
      protocols: splitLines(fields.protocols),
      ruleJson,
    }
  })
}

/**
 * Parse the raw rule_json escape hatch, returning the object or null when the
 * string is not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body).
 * Mirrors the tenable tags `parseFilterObject` helper.
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

/** True when an order value was authored at all (vs left blank). */
export function orderProvided(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false
  if (typeof raw === 'string') return raw.trim().length > 0
  return true
}

/**
 * Interpret an authored order value: a positive integer, else null. Accepts a
 * number or a numeric string (the canvas may hand either over).
 */
export function parseOrderValue(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Resolve the order deploy should send: the authored positive integer, or 1. */
export function resolveOrder(spec: UrlFilteringRuleSpec): number {
  return parseOrderValue(spec.orderRaw) ?? 1
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate URL filtering rule configurations against ZIA constraints: a name is
 * required, capped at 255 chars, and — a rule's logical identity — must be
 * unique across the canvas (matched case-insensitively, since ZIA rejects rules
 * differing only in case). The order, when set, must be a positive integer, and
 * the rule_json escape hatch, when non-blank, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUrlFilteringRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique (case-insensitive)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'URL filtering rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `URL filtering rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate URL filtering rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_url_filtering_rule',
        })
      }
      seen.add(key)
    }

    // order — optional; when set it must be a positive integer
    if (orderProvided(spec.orderRaw) && parseOrderValue(spec.orderRaw) === null) {
      errors.push({
        field: `${prefix}.order`,
        message: 'Rule order must be a positive integer',
        code: 'invalid_order',
      })
    }

    // rule_json — optional; when present it must parse as a JSON object
    if (spec.ruleJson && parseRuleObject(spec.ruleJson) === null) {
      errors.push({
        field: `${prefix}.rule_json`,
        message:
          'Rule JSON must be a valid JSON object, e.g. {"urlCategories":["OTHER_ADULT_MATERIAL"]} — leave blank for a rule with no extra criteria',
        code: 'invalid_rule_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
