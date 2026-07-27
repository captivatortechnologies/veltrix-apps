import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Custom IOA Rule Group API constraints -----------------------------------

/** platform is lowercase in the IOA rules API and immutable after creation. */
export const IOA_PLATFORMS = ['windows', 'mac', 'linux'] as const

/** pattern_severity values accepted by the IOA rules API. */
export const IOA_PATTERN_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const

export const MAX_RULE_GROUP_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

/** One rule declared under a group, as the IOA rules API expects it. */
export interface RuleSpec {
  name: string
  ruletypeId: string
  dispositionId: number
  patternSeverity: string
  /** Rule-type-specific field values, passed through to the API verbatim. */
  fieldValues: unknown[]
  enabled: boolean
  description?: string
  comment?: string
}

export interface RuleGroupSpec {
  sectionName: string
  name: string
  platform: string
  description?: string
  enabled: boolean
  comment?: string
  rulesRaw?: string
}

/** Shape of a rule embedded in a rule group returned by the IOA rules API. */
export interface LiveRule {
  /** Numeric identifier of a rule within its group — used to update/delete it. */
  instance_id?: string
  id?: string
  name?: string
  description?: string
  ruletype_id?: string
  disposition_id?: number
  pattern_severity?: string
  field_values?: unknown[]
  enabled?: boolean
  version?: number
}

/** Shape of a rule group returned by GET /ioarules/combined/rule-groups/v1. */
export interface LiveRuleGroup {
  id?: string
  name?: string
  description?: string
  platform?: string
  enabled?: boolean
  comment?: string
  /** Optimistic-concurrency token — every PATCH must echo the current value. */
  version?: number
  rules?: LiveRule[]
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Each canvas section describes one custom IOA rule group. */
export function extractRuleGroupSpecs(canvas: CanvasSnapshot): RuleGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawPlatform = typeof fields.platform === 'string' ? fields.platform.trim().toLowerCase() : 'windows'
    const platform =
      (IOA_PLATFORMS as readonly string[]).find((p) => p === rawPlatform) ?? rawPlatform

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      platform,
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      enabled: coerceBoolean(fields.enabled, false),
      comment:
        typeof fields.comment === 'string' && fields.comment.trim()
          ? fields.comment.trim()
          : undefined,
      rulesRaw:
        typeof fields.rules === 'string' && fields.rules.trim() ? fields.rules.trim() : undefined,
    }
  })
}

/**
 * Parse and structurally validate the rules JSON. Each entry must carry a name,
 * a ruletypeId, a numeric dispositionId, a known patternSeverity, and (if
 * present) fieldValues as an array. Rule names must be unique within the group.
 */
export function parseRuleSpecs(raw: string | undefined): {
  rules: RuleSpec[]
  errors: string[]
} {
  if (!raw) return { rules: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      rules: [],
      errors: [`Rules is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (!Array.isArray(parsed)) {
    return { rules: [], errors: ['Rules must be a JSON array of rule objects'] }
  }

  const rules: RuleSpec[] = []
  const errors: string[] = []
  const seenNames = new Set<string>()

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Rule #${index + 1}: must be an object`)
      return
    }
    const e = entry as Record<string, unknown>

    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!name) {
      errors.push(`Rule #${index + 1}: "name" must be a non-empty string`)
      return
    }
    if (seenNames.has(name.toLowerCase())) {
      errors.push(`Rule "${name}": declared more than once`)
      return
    }
    seenNames.add(name.toLowerCase())

    const ruletypeId =
      typeof e.ruletypeId === 'string'
        ? e.ruletypeId.trim()
        : typeof e.ruletypeId === 'number'
          ? String(e.ruletypeId)
          : ''
    if (!ruletypeId) {
      errors.push(`Rule "${name}": "ruletypeId" is required (from the rule-types lookup)`)
      return
    }

    const rawDisposition =
      typeof e.dispositionId === 'number'
        ? e.dispositionId
        : typeof e.dispositionId === 'string' && /^\d+$/.test(e.dispositionId.trim())
          ? Number(e.dispositionId.trim())
          : NaN
    if (!Number.isInteger(rawDisposition) || rawDisposition <= 0) {
      errors.push(`Rule "${name}": "dispositionId" must be a positive integer (e.g. 10, 20, 30)`)
      return
    }

    const patternSeverity =
      typeof e.patternSeverity === 'string' ? e.patternSeverity.trim().toLowerCase() : ''
    if (!(IOA_PATTERN_SEVERITIES as readonly string[]).includes(patternSeverity)) {
      errors.push(`Rule "${name}": "patternSeverity" must be one of ${IOA_PATTERN_SEVERITIES.join(', ')}`)
      return
    }

    if (e.fieldValues !== undefined && !Array.isArray(e.fieldValues)) {
      errors.push(`Rule "${name}": "fieldValues" must be an array when provided`)
      return
    }

    rules.push({
      name,
      ruletypeId,
      dispositionId: rawDisposition,
      patternSeverity,
      fieldValues: Array.isArray(e.fieldValues) ? e.fieldValues : [],
      enabled: coerceBoolean(e.enabled, false),
      description: typeof e.description === 'string' && e.description.trim() ? e.description.trim() : undefined,
      comment: typeof e.comment === 'string' && e.comment.trim() ? e.comment.trim() : undefined,
    })
  })

  return { rules, errors }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom IOA rule group configurations against Custom IOA API
 * constraints: naming, platform, and the rules model (rule type, disposition,
 * pattern severity, field values).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRuleGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule group name must be ${MAX_RULE_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = `${spec.platform}:${spec.name.toLowerCase()}`
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule group "${spec.name}" for platform ${spec.platform} — each group may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // platform — lowercase, immutable after creation
    if (!(IOA_PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${IOA_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    // rules JSON
    const { rules, errors: ruleErrors } = parseRuleSpecs(spec.rulesRaw)
    for (const message of ruleErrors) {
      errors.push({ field: `${prefix}.rules`, message, code: 'invalid_rules' })
    }

    // an enabled group with no rules detects nothing
    if (spec.enabled && ruleErrors.length === 0 && rules.length === 0) {
      warnings.push({
        field: `${prefix}.rules`,
        message: 'Rule group is enabled but declares no rules — it will not detect anything',
        code: 'no_rules',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
