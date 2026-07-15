import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Firewall IPS Rules constraints --------------------------------------

/** ZIA caps a firewall IPS rule name at 255 characters. */
export const MAX_RULE_NAME_LENGTH = 255

/** Enforcement actions ZIA accepts for a firewall IPS rule. */
export const IPS_RULE_ACTIONS = ['ALLOW', 'BLOCK_DROP', 'BLOCK_RESET', 'BYPASS_IPS'] as const
/** Rule states. */
export const IPS_RULE_STATES = ['ENABLED', 'DISABLED'] as const

export const DEFAULT_ACTION = 'ALLOW'
export const DEFAULT_STATE = 'ENABLED'
/** Order defaults to 1 (highest precedence) when the author leaves it blank. */
export const DEFAULT_ORDER = 1

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IpsRuleSpec {
  sectionName: string
  /** The rule name — its logical identity (list + match). */
  name: string
  /**
   * Raw order value as authored ('' when blank). Kept raw so validate can flag a
   * non-positive-integer while deploy/drift resolve it through parsePositiveInt.
   */
  order: string
  /** ENABLED | DISABLED — defaulted to ENABLED. */
  state: string
  /** ALLOW | BLOCK_DROP | BLOCK_RESET | BYPASS_IPS — defaulted to ALLOW. */
  action: string
  /** Raw advanced-criteria JSON string; undefined/blank = use only the scalars. */
  ruleJson?: string
}

/**
 * Shape of a firewall IPS rule returned by GET /firewallIpsRules. The full body
 * carries many more attributes (src/dest groups, services, labels, …) — only the
 * managed scalars and the default-rule markers are typed here; the rest ride in
 * the JSON escape hatch and are captured wholesale for rollback.
 */
export interface LiveIpsRule {
  id?: number
  name?: string
  order?: number
  rank?: number
  state?: string
  action?: string
  /** ZIA marks its protected built-in rule with one of these — never modify it. */
  isDefaultRule?: boolean
  defaultRule?: boolean
  predefined?: boolean
  [key: string]: unknown
}

/** Each canvas item describes one ZIA firewall IPS rule. */
export function extractIpsRuleSpecs(canvas: CanvasSnapshot): IpsRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const ruleJson =
      typeof fields.rule_json === 'string' && fields.rule_json.trim()
        ? fields.rule_json.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      order: fields.order == null ? '' : String(fields.order).trim(),
      state: normalizeChoice(fields.state, DEFAULT_STATE),
      action: normalizeChoice(fields.action, DEFAULT_ACTION),
      ruleJson,
    }
  })
}

/** Upper-case a select value, falling back to a default when blank. */
function normalizeChoice(raw: unknown, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
  return value || fallback
}

/**
 * Parse an order field to a positive integer, or null when blank/invalid.
 * Shared by validate (to reject bad input) and deploy/drift (to resolve the
 * effective order, defaulting to DEFAULT_ORDER).
 */
export function parsePositiveInt(raw: string): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Parse the advanced-criteria JSON, returning the object or null when the string
 * is not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body) —
 * mirrors the tenable tags parseFilterObject helper.
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

// --- Validate handler ---------------------------------------------------------

/**
 * Validate firewall IPS rule configurations against ZIA constraints: a name is
 * required, capped at 255 chars, and unique across the canvas (matched
 * case-insensitively, since ZIA rejects rules differing only in case); the order
 * — when set — must be a positive integer; and the advanced-criteria JSON, when
 * present, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIpsRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, and unique (its logical identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Firewall IPS rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Firewall IPS rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate firewall IPS rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_ips_rule',
        })
      }
      seen.add(key)
    }

    // order — optional; when set it must be a positive integer
    if (spec.order && parsePositiveInt(spec.order) === null) {
      errors.push({
        field: `${prefix}.order`,
        message: 'Rule order must be a positive integer (1 = highest precedence)',
        code: 'invalid_order',
      })
    }

    // rule_json — optional; when present it must parse to a JSON object
    if (spec.ruleJson && parseRuleObject(spec.ruleJson) === null) {
      errors.push({
        field: `${prefix}.rule_json`,
        message:
          'Advanced rule JSON must be a valid JSON object, e.g. {"srcIps":["10.0.0.0/8"],"destCountries":["COUNTRY_CN"]} — leave blank to deploy with only name/order/state/action',
        code: 'invalid_rule_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
