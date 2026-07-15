import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA File Type Control Rules constraints ---------------------------------

/** ZIA caps a policy rule name at 255 characters. */
export const MAX_RULE_NAME_LENGTH = 255

/** Rule lifecycle state. */
export const VALID_STATES = ['ENABLED', 'DISABLED'] as const
export const DEFAULT_STATE = 'ENABLED'

/** Action taken when the rule matches. */
export const VALID_ACTIONS = ['ALLOW', 'BLOCK', 'CAUTION'] as const
export const DEFAULT_ACTION = 'BLOCK'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface FileTypeRuleSpec {
  sectionName: string
  /** The rule name — its logical identity (list + match). */
  name: string
  /** Parsed evaluation order. undefined when unset — deploy defaults to 1. */
  order?: number
  /** True when an order value was entered but is not a positive integer. */
  orderInvalid: boolean
  /** Original order text, surfaced by validate on an invalid value. */
  orderRaw: string
  state: string
  action: string
  /**
   * Parsed advanced-criteria JSON object — file types and object references
   * (fileTypes[], protocols, users/groups/locations/urlCategories, …). This is
   * the escape hatch for the many rule fields that are not first-class here.
   * undefined when blank OR when it did not parse to a JSON object.
   */
  ruleJson?: Record<string, unknown>
  /** True when rule_json was provided but did not parse to a JSON object. */
  ruleJsonInvalid: boolean
}

/**
 * Shape of a file type rule returned by GET /fileTypeRules. Only the managed
 * scalars are typed; the index signature carries the advanced JSON fields
 * (fileTypes, references) verbatim so rollback can restore a full prior body.
 * `isDefaultRule` / `defaultRule` / `predefined` flag the protected built-in
 * default rule that must never be modified or deleted.
 */
export interface LiveFileTypeRule {
  id?: number
  name?: string
  order?: number
  state?: string
  action?: string
  rank?: number
  isDefaultRule?: boolean
  defaultRule?: boolean
  predefined?: boolean
  [key: string]: unknown
}

/**
 * Parse the `rule_json` escape-hatch value. Returns the parsed object, or null
 * when the value is blank, malformed, or parses to a non-object (array/primitive).
 * Mirrors the reference JSON-body helper pattern (e.g. tenable tags parseFilterObject).
 */
export function parseRuleObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** Constrain a select value to a known option, falling back to the default. */
function normalizeChoice(value: unknown, valid: readonly string[], fallback: string): string {
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase()
    if (valid.includes(upper)) return upper
  }
  return fallback
}

/** Each canvas item describes one ZIA file type control rule. */
export function extractFileTypeRuleSpecs(canvas: CanvasSnapshot): FileTypeRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const orderRaw =
      fields.order === undefined || fields.order === null ? '' : String(fields.order).trim()
    let order: number | undefined
    let orderInvalid = false
    if (orderRaw !== '') {
      const n = Number(orderRaw)
      if (Number.isInteger(n) && n > 0) order = n
      else orderInvalid = true
    }

    const ruleJsonRaw = typeof fields.rule_json === 'string' ? fields.rule_json.trim() : ''
    let ruleJson: Record<string, unknown> | undefined
    let ruleJsonInvalid = false
    if (ruleJsonRaw !== '') {
      const parsed = parseRuleObject(ruleJsonRaw)
      if (parsed) ruleJson = parsed
      else ruleJsonInvalid = true
    }

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      order,
      orderInvalid,
      orderRaw,
      state: normalizeChoice(fields.state, VALID_STATES, DEFAULT_STATE),
      action: normalizeChoice(fields.action, VALID_ACTIONS, DEFAULT_ACTION),
      ruleJson,
      ruleJsonInvalid,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate file type control rule configurations against ZIA constraints: a name
 * is required, capped at 255 chars, and unique across the canvas (case-insensitive,
 * since ZIA rejects rules differing only in case). The order — when set — must be
 * a positive integer, and the `rule_json` escape hatch — when non-blank — must
 * parse to a JSON object (the place for fileTypes[] and object references).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFileTypeRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'File type rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `File type rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate file type rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_file_type_rule',
        })
      }
      seen.add(key)
    }

    if (spec.orderInvalid) {
      errors.push({
        field: `${prefix}.order`,
        message: `Invalid order "${spec.orderRaw}" — order must be a positive integer (1 = first)`,
        code: 'invalid_order',
      })
    }

    if (spec.ruleJsonInvalid) {
      errors.push({
        field: `${prefix}.rule_json`,
        message:
          'Advanced Criteria must be a JSON object, e.g. {"fileTypes":["FTCATEGORY_PDF"]} — check the syntax',
        code: 'invalid_rule_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
