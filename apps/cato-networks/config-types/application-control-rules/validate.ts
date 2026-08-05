import type { CanvasSnapshot, PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { items, parseJsonObject, type RulePosition } from '../lib/catoPolicy'
import type { RuleSpec } from '../lib/catoRulePipeline'

const VALID_RULE_TYPES = ['APPLICATION', 'DATA', 'FILE'] as const
const VALID_POSITIONS: RulePosition[] = ['FIRST_IN_SECTION', 'LAST_IN_SECTION', 'BEFORE_RULE', 'AFTER_RULE']

export type ApplicationControlRuleType = (typeof VALID_RULE_TYPES)[number]

const RULE_TYPE_KEY: Record<ApplicationControlRuleType, string> = {
  APPLICATION: 'applicationRule',
  DATA: 'dataRule',
  FILE: 'fileRule',
}

export interface ApplicationControlRuleSpec extends RuleSpec {
  description: string
  enabled: boolean
  ruleType: ApplicationControlRuleType
  ruleJson?: string
}

/** Extract one Application Control rule spec per canvas item. */
export function extractRuleSpecs(canvas: CanvasSnapshot): ApplicationControlRuleSpec[] {
  return items(canvas).map((item) => {
    const fields = item.fields ?? {}
    const ruleType = (typeof fields.ruleType === 'string' ? fields.ruleType : 'APPLICATION') as ApplicationControlRuleType
    const position = (typeof fields.position === 'string' ? fields.position : 'FIRST_IN_SECTION') as RulePosition
    return {
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      enabled: fields.enabled !== false,
      section: typeof fields.section === 'string' ? fields.section.trim() : '',
      ruleType: VALID_RULE_TYPES.includes(ruleType) ? ruleType : 'APPLICATION',
      position: VALID_POSITIONS.includes(position) ? position : 'FIRST_IN_SECTION',
      positionRuleName: typeof fields.positionRuleName === 'string' ? fields.positionRuleName.trim() : undefined,
      ruleJson: typeof fields.rule_json === 'string' ? fields.rule_json : undefined,
    }
  })
}

/** Build the `rule` body for addRule/updateRule: the JSON escape hatch (keyed by ruleType) merged with first-class fields winning. */
export function buildRuleData(spec: ApplicationControlRuleSpec): Record<string, unknown> {
  const parsed = spec.ruleJson ? parseJsonObject(spec.ruleJson) : null
  return {
    ...(parsed ?? {}),
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    ruleType: spec.ruleType,
  }
}

/**
 * Validate Application Control rule items. Static only - no target access:
 *   - name is required, <= 255 chars, and unique within the canvas
 *   - section is required
 *   - positionRuleName is required when position is BEFORE_RULE/AFTER_RULE
 *   - rule_json is required, must parse as a JSON object, and must carry
 *     exactly the key matching ruleType (applicationRule/dataRule/fileRule)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    } else {
      if (spec.name.length > 255) {
        errors.push({ field: `${prefix}.name`, message: 'Rule name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate rule "${spec.name}" - each rule may only be declared once.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
    }

    if (!spec.section) {
      errors.push({ field: `${prefix}.section`, message: 'Section is required.', code: 'EMPTY_SECTION' })
    }

    if ((spec.position === 'BEFORE_RULE' || spec.position === 'AFTER_RULE') && !spec.positionRuleName) {
      errors.push({
        field: `${prefix}.positionRuleName`,
        message: 'Relative To Rule is required when Position is "Before another rule" or "After another rule".',
        code: 'MISSING_POSITION_REF',
      })
    }

    if (!spec.ruleJson) {
      errors.push({ field: `${prefix}.rule_json`, message: 'Rule Body (JSON) is required.', code: 'EMPTY_RULE_BODY' })
    } else {
      const parsed = parseJsonObject(spec.ruleJson)
      if (parsed === undefined) {
        errors.push({ field: `${prefix}.rule_json`, message: 'Rule Body (JSON) must be a valid JSON object.', code: 'INVALID_JSON' })
      } else if (parsed) {
        const expectedKey = RULE_TYPE_KEY[spec.ruleType]
        if (!(expectedKey in parsed)) {
          errors.push({
            field: `${prefix}.rule_json`,
            message: `Rule Body (JSON) must have a top-level "${expectedKey}" key matching Rule Type "${spec.ruleType}".`,
            code: 'RULE_TYPE_KEY_MISMATCH',
          })
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
