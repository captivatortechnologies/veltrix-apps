import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA SSL Inspection Rule constraints -------------------------------------

/** ZIA caps a policy rule name at 255 characters. */
export const MAX_RULE_NAME_LENGTH = 255

/** The `state` values ZIA accepts on a policy rule. */
export const RULE_STATES = ['ENABLED', 'DISABLED'] as const

/**
 * The `type` values the SSL `action` object accepts. Informational only — the
 * action is an OBJECT kept inside rule_json (this rule type has no first-class
 * action field), so validate does not enforce a specific type, only that an
 * `action` key is present (warning) when a rule_json body was supplied.
 */
export const SSL_ACTION_TYPES = ['DECRYPT', 'DO_NOT_DECRYPT'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SslRuleSpec {
  sectionName: string
  /** The SSL inspection rule name — its logical identity (list + match). */
  name: string
  /**
   * Evaluation order. `undefined` = not provided (deploy defaults to 1). A
   * provided-but-non-numeric value parses to NaN so validate can reject it.
   */
  order?: number
  /** Rule state; defaults to ENABLED when the field is blank. */
  state: string
  /**
   * Raw rule_json string — the SSL `action` object plus the advanced-criteria
   * escape hatch. undefined = blank. The action lives here (not a first-class
   * field) because ZIA models it as an object, not a scalar.
   */
  ruleJson?: string
}

/** Shape of an SSL inspection rule returned by GET /sslInspectionRules. */
export interface LiveSslRule {
  id?: number
  name?: string
  order?: number
  state?: string
  /** The SSL action object, e.g. { type: "DECRYPT" }. */
  action?: { type?: string; [key: string]: unknown }
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

/** Each canvas item describes one ZIA SSL inspection rule. */
export function extractSslRuleSpecs(canvas: CanvasSnapshot): SslRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      order: readOrder(fields.order),
      state: nonEmpty(fields.state) ?? 'ENABLED',
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
 * Validate SSL inspection rule configurations against ZIA constraints: a name is
 * required, capped at 255 chars, and unique across the canvas (matched
 * case-insensitively, since ZIA rejects rules differing only in case); `order`,
 * when set, must be a positive integer; and `rule_json`, when present, must
 * parse to a JSON object.
 *
 * SPECIAL: the SSL action is an object carried inside rule_json (there is no
 * first-class action field). A rule_json body that parses but has no `action`
 * key is not a hard error — ZIA may reject it, but authors sometimes stage a
 * criteria-only body first — so this raises a non-blocking WARNING pointing them
 * at the expected shape rather than failing validation.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSslRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique (case-insensitive)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'SSL inspection rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `SSL inspection rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate SSL inspection rule "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_ssl_rule',
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

    // rule_json — optional; when present must parse to a JSON object, and the SSL
    // action object should live inside it.
    if (spec.ruleJson) {
      const parsed = parseRuleObject(spec.ruleJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.rule_json`,
          message:
            'Rule JSON must be a valid JSON object, e.g. {"action":{"type":"DECRYPT"}} — leave blank for a rule with no body',
          code: 'invalid_ssl_rule_json',
        })
      } else if (!('action' in parsed)) {
        // WARNING, not an error: the SSL action object is expected here.
        warnings.push({
          field: `${prefix}.rule_json`,
          message:
            'Rule JSON has no "action" key — SSL inspection rules take the action as an object, e.g. {"action":{"type":"DECRYPT"}} or {"action":{"type":"DO_NOT_DECRYPT"}}; ZIA will likely reject a rule with no action',
          code: 'missing_ssl_action',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
