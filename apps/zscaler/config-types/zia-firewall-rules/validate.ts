import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Firewall Filtering Rules constraints --------------------------------

/** ZIA caps a firewall rule name at 255 characters. */
export const MAX_RULE_NAME_LENGTH = 255

/** Firewall actions the rule may take. */
export const FIREWALL_ACTIONS = ['ALLOW', 'BLOCK_DROP', 'BLOCK_RESET'] as const
export const DEFAULT_FIREWALL_ACTION = 'BLOCK_DROP'
export const DEFAULT_RULE_STATE = 'ENABLED'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface FirewallRuleSpec {
  sectionName: string
  /** The firewall rule name — its logical identity (list + match). */
  name: string
  /** Evaluation order; undefined when the field was left blank (deploy defaults to 1). */
  order?: number
  /** ENABLED | DISABLED — defaulted here so downstream handlers stay simple. */
  state: string
  /** ALLOW | BLOCK_DROP | BLOCK_RESET — defaulted here. */
  action: string
  /** Raw JSON criteria string; absent/blank = a rule with no extra criteria. */
  ruleJson?: string
}

/** Shape of a firewall rule returned by GET /firewallFilteringRules. */
export interface LiveFirewallRule {
  id?: number
  name?: string
  order?: number
  rank?: number
  state?: string
  action?: string
  /** Markers that identify the read-only, predefined default rule. */
  isDefaultRule?: boolean
  defaultRule?: boolean
  predefined?: boolean
  [key: string]: unknown
}

/** Each canvas item describes one ZIA firewall filtering rule. */
export function extractFirewallRuleSpecs(canvas: CanvasSnapshot): FirewallRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    // order may arrive as a number (default) or a string (typed input). Blank =
    // undefined so deploy applies its own default and validate does not flag it.
    const rawOrder = fields.order
    let order: number | undefined
    if (typeof rawOrder === 'number') {
      order = rawOrder
    } else if (typeof rawOrder === 'string' && rawOrder.trim() !== '') {
      order = Number(rawOrder.trim())
    }

    const state =
      typeof fields.state === 'string' && fields.state.trim() ? fields.state.trim() : DEFAULT_RULE_STATE
    const action =
      typeof fields.action === 'string' && fields.action.trim()
        ? fields.action.trim()
        : DEFAULT_FIREWALL_ACTION
    const ruleJson =
      typeof fields.rule_json === 'string' && fields.rule_json.trim()
        ? fields.rule_json.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      order,
      state,
      action,
      ruleJson,
    }
  })
}

/**
 * Parse the raw rule-criteria string, returning the object or null when the
 * string is not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body).
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
 * Validate firewall rule configurations against ZIA constraints: a name is
 * required (its logical identity) and capped at 255 chars and must be unique
 * across the canvas (matched case-insensitively, since ZIA rejects rules
 * differing only in case); `order`, when set, must be a positive integer; and
 * the `rule_json` escape hatch, when present, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFirewallRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique (case-insensitive)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Firewall rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Firewall rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate firewall rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_firewall_rule',
        })
      }
      seen.add(key)
    }

    // order — optional; when set it must be a positive integer
    if (spec.order !== undefined && (!Number.isInteger(spec.order) || spec.order < 1)) {
      errors.push({
        field: `${prefix}.order`,
        message: 'Order must be a positive integer (1 or greater)',
        code: 'invalid_order',
      })
    }

    // rule_json — optional; when present it must parse to a JSON object
    if (spec.ruleJson && parseRuleObject(spec.ruleJson) === null) {
      errors.push({
        field: `${prefix}.rule_json`,
        message:
          'Rule criteria must be a valid JSON object, e.g. {"srcIpGroups":[{"id":1}]} — leave blank for a rule with no extra criteria',
        code: 'invalid_rule_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
