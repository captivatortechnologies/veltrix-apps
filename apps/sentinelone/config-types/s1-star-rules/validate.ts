import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne STAR rule constraints ---------------------------------------

export const QUERY_TYPES = ['events', 'processes'] as const
export const SEVERITIES = ['Low', 'Medium', 'High'] as const
export const TREAT_AS_THREAT = ['none', 'Malicious', 'Suspicious'] as const
export const EXPIRATION_MODES = ['Permanent', 'Temporary'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface StarRuleSpec {
  sectionName: string
  name: string
  description?: string
  s1ql: string
  queryType: string
  severity: string
  activate: boolean
  treatAsThreat: string
  networkQuarantine: boolean
  expirationMode: string
  expiration?: string
}

/** Shape of a STAR rule returned by GET /cloud-detection/rules. */
export interface LiveStarRule {
  id?: string
  name?: string
  description?: string
  s1ql?: string
  queryType?: string
  severity?: string
  status?: string
  networkQuarantine?: boolean
  expirationMode?: string
  expiration?: string
  treatAsThreat?: string
  queryLang?: string
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * The rule's logical identity at a scope: its name. Case-insensitive and trimmed
 * so a re-typed name with different casing/whitespace reconciles to the same rule
 * both across the canvas (dedupe) and against the live scope (list-match).
 */
export function ruleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** True when a live rule's status marks it as enabled (Active). */
export function isRuleActive(status: string | undefined): boolean {
  return (status ?? '').trim().toLowerCase() === 'active'
}

/** Each canvas item describes one SentinelOne STAR rule. */
export function extractStarRuleSpecs(canvas: CanvasSnapshot): StarRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const description = str(fields.description) || undefined
    const expiration = str(fields.expiration) || undefined
    return {
      sectionName: section.name,
      name: str(fields.name),
      description,
      s1ql: str(fields.s1ql),
      queryType: str(fields.query_type) || 'events',
      severity: str(fields.severity) || 'Medium',
      activate: readBool(fields.activate, true),
      treatAsThreat: str(fields.treat_as_threat) || 'none',
      networkQuarantine: readBool(fields.network_quarantine, false),
      expirationMode: str(fields.expiration_mode) || 'Permanent',
      expiration,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate STAR rule configurations against SentinelOne constraints: name and
 * S1QL are required; query type, severity and expiration mode must be from the
 * supported sets; a Temporary rule needs an expiration timestamp; and the rule
 * name (case-insensitive) must be unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractStarRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    }
    if (!spec.s1ql) {
      errors.push({ field: `${prefix}.s1ql`, message: 'S1QL query is required', code: 'required' })
    }
    if (!QUERY_TYPES.includes(spec.queryType as (typeof QUERY_TYPES)[number])) {
      errors.push({ field: `${prefix}.query_type`, message: `Unsupported query type "${spec.queryType}"`, code: 'invalid_query_type' })
    }
    if (!SEVERITIES.includes(spec.severity as (typeof SEVERITIES)[number])) {
      errors.push({ field: `${prefix}.severity`, message: `Unsupported severity "${spec.severity}"`, code: 'invalid_severity' })
    }
    if (!TREAT_AS_THREAT.includes(spec.treatAsThreat as (typeof TREAT_AS_THREAT)[number])) {
      errors.push({ field: `${prefix}.treat_as_threat`, message: `Unsupported threat verdict "${spec.treatAsThreat}"`, code: 'invalid_treat_as_threat' })
    }
    if (!EXPIRATION_MODES.includes(spec.expirationMode as (typeof EXPIRATION_MODES)[number])) {
      errors.push({ field: `${prefix}.expiration_mode`, message: `Unsupported expiration mode "${spec.expirationMode}"`, code: 'invalid_expiration_mode' })
    } else if (spec.expirationMode === 'Temporary' && !spec.expiration) {
      errors.push({ field: `${prefix}.expiration`, message: 'Expiration is required when the expiration mode is Temporary', code: 'required' })
    }

    if (spec.name) {
      const key = ruleKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" — each rule name may only be declared once`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
