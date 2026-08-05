import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Exabeam Correlation Rules API constraints -------------------------------
// https://developers.exabeam.com/exabeam/reference/correlation-create-rule
// https://developers.exabeam.com/exabeam/reference/correlation-get-all-rules
// https://developers.exabeam.com/exabeam/reference/correlation-get-rule-by-id
// https://developers.exabeam.com/exabeam/reference/correlation-update-rule
// https://developers.exabeam.com/exabeam/reference/correlation-delete-rule-by-id
//
// GET    /correlation-rules/v2/rules?nameContains=   - list (optionally filtered)
// POST   /correlation-rules/v2/rules                 - create
// GET    /correlation-rules/v2/rules/{ruleId}         - read
// PUT    /correlation-rules/v2/rules/{ruleId}         - update (full body)
// DELETE /correlation-rules/v2/rules/{ruleId}         - delete
//
// There is no server-side uniqueness constraint on `name` — this app enforces
// uniqueness itself (within one canvas) so it has an unambiguous reconcile key.

/** A rule name is capped at 128 characters (per the API's create/update schema). */
export const MAX_RULE_NAME_LENGTH = 128

export const RULE_SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'] as const
export type RuleSeverity = (typeof RULE_SEVERITIES)[number]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface RuleSpec {
  /** Stable canvas item id — tracked across deploys so a rename updates the same live rule. */
  itemId?: string
  /** Rule name — the logical identity this app matches on. */
  name: string
  description?: string
  severity: RuleSeverity | ''
  enabled: boolean
  testMode: boolean
  /** Raw JSON text as authored; '' when left blank. */
  sequencesConfigJson: string
  suppressConfigJson: string
  delayConfigJson: string
  scheduleConfigJson: string
}

/** One parsed + validated rule, ready to send to the API. */
export interface ParsedRuleSpec extends RuleSpec {
  sequencesConfig: Record<string, unknown>
  suppressConfig?: Record<string, unknown>
  delayConfig?: Record<string, unknown>
  scheduleConfig?: Record<string, unknown>
}

/**
 * Shape of a rule returned by GET .../rules and GET .../rules/{id}. Carries an
 * index signature so server-managed fields not modeled above (author,
 * lastModifier, createdAt, updatedAt, lastTriggeredAt, timesTriggered,
 * timesSuppressed, autoDisabled) remain readable.
 */
export interface LiveRule {
  id?: string
  name?: string
  description?: string
  severity?: string
  enabled?: boolean
  testMode?: boolean
  sequencesConfig?: Record<string, unknown>
  suppressConfig?: Record<string, unknown>
  delayConfig?: Record<string, unknown>
  scheduleConfig?: Record<string, unknown>
  autoDisabled?: boolean
  author?: string
  lastModifier?: string
  createdAt?: string
  updatedAt?: string
  lastTriggeredAt?: string
  timesTriggered?: number
  timesSuppressed?: number
  [key: string]: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Each canvas item describes one Exabeam correlation rule. */
export function extractRuleSpecs(canvas: CanvasSnapshot): RuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    const severity = asString(fields.severity).trim().toLowerCase()
    return {
      itemId: item.id,
      name: asString(fields.name).trim(),
      description: asString(fields.description).trim() || undefined,
      severity: (RULE_SEVERITIES as readonly string[]).includes(severity) ? (severity as RuleSeverity) : '',
      enabled: fields.enabled === true,
      testMode: fields.testMode === true,
      sequencesConfigJson: asString(fields.sequencesConfigJson).trim(),
      suppressConfigJson: asString(fields.suppressConfigJson).trim(),
      delayConfigJson: asString(fields.delayConfigJson).trim(),
      scheduleConfigJson: asString(fields.scheduleConfigJson).trim(),
    }
  })
}

/** Parse a required JSON-object field. Returns an error string on failure, else the parsed object. */
function parseJsonObject(raw: string, label: string): { value?: Record<string, unknown>; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { error: `${label} is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: `${label} must be a JSON object` }
  }
  return { value: parsed as Record<string, unknown> }
}

/**
 * Validate a rule's `sequencesConfig`: must have a non-empty `sequences`
 * array, each entry needing a non-empty `query` string and a `condition`
 * object (the API's own required shape per correlation-create-rule).
 */
function validateSequencesConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = []
  const sequences = config.sequences
  if (!Array.isArray(sequences) || sequences.length === 0) {
    errors.push('sequencesConfig.sequences must be a non-empty array')
    return errors
  }
  sequences.forEach((seq, i) => {
    if (!seq || typeof seq !== 'object' || Array.isArray(seq)) {
      errors.push(`sequencesConfig.sequences[${i}] must be an object`)
      return
    }
    const s = seq as Record<string, unknown>
    if (typeof s.query !== 'string' || !s.query.trim()) {
      errors.push(`sequencesConfig.sequences[${i}].query is required`)
    }
    if (!s.condition || typeof s.condition !== 'object' || Array.isArray(s.condition)) {
      errors.push(`sequencesConfig.sequences[${i}].condition is required and must be an object`)
    }
  })
  if (sequences.length > 1 && (!config.commonProperties || typeof config.commonProperties !== 'object')) {
    errors.push('sequencesConfig.commonProperties is required when declaring more than one sequence')
  }
  return errors
}

/** Parse every JSON field on a validated spec. Throws never — collects errors instead. */
export function parseRuleSpec(spec: RuleSpec, prefix: string, errors: ValidationResult['errors']): ParsedRuleSpec | null {
  if (!spec.sequencesConfigJson) {
    errors.push({ field: `${prefix}.sequencesConfigJson`, message: 'Sequences Config (JSON) is required', code: 'required' })
    return null
  }
  const sequences = parseJsonObject(spec.sequencesConfigJson, 'Sequences Config (JSON)')
  if (sequences.error) {
    errors.push({ field: `${prefix}.sequencesConfigJson`, message: sequences.error, code: 'invalid_json' })
    return null
  }
  for (const msg of validateSequencesConfig(sequences.value!)) {
    errors.push({ field: `${prefix}.sequencesConfigJson`, message: msg, code: 'invalid_sequences_config' })
  }

  const parsed: ParsedRuleSpec = { ...spec, sequencesConfig: sequences.value! }

  for (const [key, label] of [
    ['suppressConfigJson', 'Suppression Config (JSON)'],
    ['delayConfigJson', 'Delay Config (JSON)'],
    ['scheduleConfigJson', 'Schedule Config (JSON)'],
  ] as const) {
    const raw = spec[key]
    if (!raw) continue
    const result = parseJsonObject(raw, label)
    if (result.error) {
      errors.push({ field: `${prefix}.${key}`, message: result.error, code: 'invalid_json' })
      continue
    }
    if (key === 'suppressConfigJson') parsed.suppressConfig = result.value
    if (key === 'delayConfigJson') parsed.delayConfig = result.value
    if (key === 'scheduleConfigJson') parsed.scheduleConfig = result.value
  }

  return parsed
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate correlation rule configurations against the Exabeam Correlation
 * Rules API. Static only — it never contacts Exabeam:
 *   - name is required, <= 128 chars, and unique within the canvas
 *   - severity is required and one of none/low/medium/high/critical
 *   - sequencesConfigJson is required, must be valid JSON, and must contain a
 *     non-empty `sequences` array whose entries each have a `query` and a
 *     `condition` (commonProperties required for multi-sequence rules)
 *   - suppressConfigJson / delayConfigJson / scheduleConfigJson, when set,
 *     must be valid JSON objects
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" - each rule may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (!spec.severity) {
      errors.push({
        field: `${prefix}.severity`,
        message: `Severity is required and must be one of ${RULE_SEVERITIES.join(', ')}`,
        code: 'required',
      })
    }

    parseRuleSpec(spec, prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}
