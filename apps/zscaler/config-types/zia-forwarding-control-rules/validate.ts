import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Forwarding Control Rule constraints ----------------------------------

/** ZIA caps a policy rule name at 255 characters. */
export const MAX_RULE_NAME_LENGTH = 255

/** The `type` values ZIA's /forwardingRules accepts (terraform-provider-zia resource_zia_forwarding_control_rule.go). */
export const FORWARDING_RULE_TYPES = [
  'FORWARDING',
  'FIREWALL',
  'DNS',
  'DNAT',
  'SNAT',
  'INTRUSION_PREVENTION',
  'EC_DNS',
  'EC_RDR',
  'EC_SELF',
  'DNS_RESPONSE',
] as const

/** The `forwardMethod` values ZIA's /forwardingRules accepts (zscaler-sdk-go ForwardingRules.ForwardMethod). */
export const FORWARD_METHODS = ['DIRECT', 'PROXYCHAIN', 'ZIA', 'ZPA', 'ECZPA', 'ECSELF', 'DROP'] as const

/** The `state` values ZIA accepts on a policy rule. */
export const RULE_STATES = ['ENABLED', 'DISABLED'] as const

/**
 * Predefined forwarding control rules ZIA ships that can never be modified or
 * deleted — matched case-insensitively by name, since the API returns no
 * boolean "predefined" marker on this resource. Sourced from
 * terraform-provider-zia's validatePredefinedRules() (resource_zia_forwarding_control_rule.go):
 * https://github.com/zscaler/terraform-provider-zia
 */
export const PROTECTED_RULE_NAMES = [
  'Client Connector Traffic Direct',
  'ZPA Pool For Stray Traffic',
  'ZIA Inspected ZPA Apps',
  'Fallback mode of ZPA Forwarding',
] as const

const PROTECTED_RULE_NAMES_LOWER = new Set(PROTECTED_RULE_NAMES.map((n) => n.toLowerCase()))

/** True when `name` matches one of ZIA's predefined forwarding control rules (case-insensitive). */
export function isProtectedRuleName(name: string): boolean {
  return PROTECTED_RULE_NAMES_LOWER.has(name.trim().toLowerCase())
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ForwardingRuleSpec {
  sectionName: string
  /** The forwarding rule name — its logical identity (list + match). */
  name: string
  /**
   * Evaluation order. `undefined` = not provided (deploy defaults to 1). A
   * provided-but-non-numeric value parses to NaN so validate can reject it.
   */
  order?: number
  /** Rule state; defaults to ENABLED when the field is blank. */
  state: string
  /** Rule type; defaults to FORWARDING when the field is blank. */
  type: string
  /** Forwarding method; defaults to DIRECT when the field is blank. */
  forwardMethod: string
  /** Raw rule_json string (the advanced-criteria escape hatch); undefined = blank. */
  ruleJson?: string
}

/** Shape of a forwarding control rule returned by GET /forwardingRules. */
export interface LiveForwardingRule {
  id?: number
  name?: string
  order?: number
  rank?: number
  state?: string
  type?: string
  forwardMethod?: string
  // Defensive: no such flag is documented on this resource today, but other ZIA
  // policy-rule endpoints DO return one — checked in case Zscaler adds it.
  isDefaultRule?: boolean
  defaultRule?: boolean
  predefined?: boolean
  // The API returns many more criteria fields; kept loose so rollback can PUT
  // a captured prior rule back verbatim.
  [key: string]: unknown
}

/** Read a canvas field as a trimmed non-empty string, or undefined. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Read the `order` field. Returns undefined when blank/absent; otherwise the
 * numeric value (NaN when a non-numeric string was entered, so validate rejects
 * it rather than silently defaulting).
 */
function readOrder(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    return Number(trimmed)
  }
  return NaN
}

/** Each canvas item describes one ZIA forwarding control rule. */
export function extractForwardingRuleSpecs(canvas: CanvasSnapshot): ForwardingRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      order: readOrder(fields.order),
      state: nonEmpty(fields.state) ?? 'ENABLED',
      type: nonEmpty(fields.type) ?? 'FORWARDING',
      forwardMethod: nonEmpty(fields.forward_method) ?? 'DIRECT',
      ruleJson: nonEmpty(fields.rule_json),
    }
  })
}

/**
 * Parse a raw rule_json string, returning the object or null when the string is
 * not a JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
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
 * Validate forwarding control rule configurations against ZIA constraints: a
 * name is required, capped at 255 chars, unique across the canvas (matched
 * case-insensitively, since ZIA rejects rules differing only in case) and must
 * not be one of ZIA's predefined rule names; `order`, when set, must be a
 * positive integer; `type` and `forward_method`, when set, must be one of the
 * accepted enum values; and `rule_json`, when present, must parse to a JSON
 * object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractForwardingRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique (case-insensitive), not predefined
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Forwarding rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Forwarding rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (isProtectedRuleName(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `"${spec.name}" is a predefined ZIA forwarding control rule and cannot be managed as code — choose a different name`,
          code: 'protected_rule_name',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate forwarding rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_forwarding_rule',
        })
      }
      seen.add(key)
    }

    // order — optional; when set must be a positive integer
    if (spec.order !== undefined && (!Number.isInteger(spec.order) || spec.order <= 0)) {
      errors.push({
        field: `${prefix}.order`,
        message: 'Rule order must be a positive integer (1 or greater)',
        code: 'invalid_order',
      })
    }

    // type — must be one of the accepted enum values
    if (!(FORWARDING_RULE_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Rule type must be one of: ${FORWARDING_RULE_TYPES.join(', ')}`,
        code: 'invalid_rule_type',
      })
    }

    // forward_method — must be one of the accepted enum values
    if (!(FORWARD_METHODS as readonly string[]).includes(spec.forwardMethod)) {
      errors.push({
        field: `${prefix}.forward_method`,
        message: `Forward method must be one of: ${FORWARD_METHODS.join(', ')}`,
        code: 'invalid_forward_method',
      })
    }

    // rule_json — optional; when present must parse to a JSON object
    if (spec.ruleJson && parseRuleObject(spec.ruleJson) === null) {
      errors.push({
        field: `${prefix}.rule_json`,
        message:
          'Rule JSON must be a valid JSON object, e.g. {"srcIps":["10.0.0.0/8"],"zpaGateway":{"id":123}} — leave blank for a rule with no extra criteria',
        code: 'invalid_rule_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
