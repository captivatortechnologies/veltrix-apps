import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Firewall DNS Rule constraints ---------------------------------------

/** ZIA caps a policy rule name at 255 characters. */
export const MAX_RULE_NAME_LENGTH = 255

/** The `action` values ZIA accepts on a firewall DNS rule (first-class field). */
export const DNS_RULE_ACTIONS = ['ALLOW', 'BLOCK', 'REDIR_REQ'] as const
/** The `state` values ZIA accepts on a policy rule. */
export const RULE_STATES = ['ENABLED', 'DISABLED'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DnsRuleSpec {
  sectionName: string
  /** The DNS rule name — its logical identity (list + match). */
  name: string
  /**
   * Evaluation order. `undefined` = not provided (deploy defaults to 1). A
   * provided-but-non-numeric value parses to NaN so validate can reject it.
   */
  order?: number
  /** Rule state; defaults to ENABLED when the field is blank. */
  state: string
  /** Rule action; defaults to ALLOW when the field is blank. */
  action: string
  /** Raw rule_json string (the advanced-criteria escape hatch); undefined = blank. */
  ruleJson?: string
}

/** Shape of a firewall DNS rule returned by GET /firewallDnsRules. */
export interface LiveDnsRule {
  id?: number
  name?: string
  order?: number
  state?: string
  action?: string
  // Markers of the PROTECTED built-in default rule (never modify or delete).
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

/** Each canvas item describes one ZIA firewall DNS rule. */
export function extractDnsRuleSpecs(canvas: CanvasSnapshot): DnsRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      order: readOrder(fields.order),
      state: nonEmpty(fields.state) ?? 'ENABLED',
      action: nonEmpty(fields.action) ?? 'ALLOW',
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
 * Validate DNS rule configurations against ZIA constraints: a name is required,
 * capped at 255 chars, and unique across the canvas (matched case-insensitively,
 * since ZIA rejects rules differing only in case); `order`, when set, must be a
 * positive integer; and `rule_json`, when present, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDnsRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique (case-insensitive)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'DNS rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `DNS rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate DNS rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_dns_rule',
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

    // rule_json — optional; when present must parse to a JSON object
    if (spec.ruleJson && parseRuleObject(spec.ruleJson) === null) {
      errors.push({
        field: `${prefix}.rule_json`,
        message:
          'Rule JSON must be a valid JSON object, e.g. {"srcIps":["10.0.0.0/8"],"dnsRuleRequestTypes":["A"]} — leave blank for a rule with no extra criteria',
        code: 'invalid_rule_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
