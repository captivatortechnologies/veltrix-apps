import type { CanvasSnapshot, PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { items, parseJsonObject, type RulePosition } from '../lib/catoPolicy'
import type { RuleSpec } from '../lib/catoRulePipeline'

const VALID_ACTIONS = ['ALLOW', 'BLOCK', 'PROMPT'] as const
const VALID_DIRECTIONS = ['TO', 'BOTH'] as const
const VALID_ORIGINS = ['ANY', 'SITE', 'REMOTE'] as const
const VALID_POSITIONS: RulePosition[] = ['FIRST_IN_SECTION', 'LAST_IN_SECTION', 'BEFORE_RULE', 'AFTER_RULE']

export type WanFirewallAction = (typeof VALID_ACTIONS)[number]
export type WanFirewallDirection = (typeof VALID_DIRECTIONS)[number]
export type ConnectionOrigin = (typeof VALID_ORIGINS)[number]

export interface WanFirewallRuleSpec extends RuleSpec {
  description: string
  enabled: boolean
  action: WanFirewallAction
  direction: WanFirewallDirection
  connectionOrigin: ConnectionOrigin
  ruleJson?: string
}

/** Extract one WAN Firewall rule spec per canvas item. */
export function extractRuleSpecs(canvas: CanvasSnapshot): WanFirewallRuleSpec[] {
  return items(canvas).map((item) => {
    const fields = item.fields ?? {}
    const action = (typeof fields.action === 'string' ? fields.action : 'BLOCK') as WanFirewallAction
    const direction = (typeof fields.direction === 'string' ? fields.direction : 'TO') as WanFirewallDirection
    const connectionOrigin = (typeof fields.connectionOrigin === 'string' ? fields.connectionOrigin : 'ANY') as ConnectionOrigin
    const position = (typeof fields.position === 'string' ? fields.position : 'FIRST_IN_SECTION') as RulePosition
    return {
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      enabled: fields.enabled !== false,
      section: typeof fields.section === 'string' ? fields.section.trim() : '',
      action: VALID_ACTIONS.includes(action) ? action : 'BLOCK',
      direction: VALID_DIRECTIONS.includes(direction) ? direction : 'TO',
      connectionOrigin: VALID_ORIGINS.includes(connectionOrigin) ? connectionOrigin : 'ANY',
      position: VALID_POSITIONS.includes(position) ? position : 'FIRST_IN_SECTION',
      positionRuleName: typeof fields.positionRuleName === 'string' ? fields.positionRuleName.trim() : undefined,
      ruleJson: typeof fields.rule_json === 'string' ? fields.rule_json : undefined,
    }
  })
}

/** Build the `rule` body for addRule/updateRule: the JSON escape hatch merged with first-class fields winning. */
export function buildRuleData(spec: WanFirewallRuleSpec): Record<string, unknown> {
  const parsed = spec.ruleJson ? parseJsonObject(spec.ruleJson) : null
  return {
    ...(parsed ?? {}),
    name: spec.name,
    description: spec.description,
    enabled: spec.enabled,
    action: spec.action,
    direction: spec.direction,
    connectionOrigin: spec.connectionOrigin,
  }
}

/**
 * Validate WAN Firewall rule items. Static only - no target access:
 *   - name is required, <= 255 chars, and unique within the canvas
 *   - section is required
 *   - positionRuleName is required when position is BEFORE_RULE/AFTER_RULE
 *   - rule_json, when present, must parse as a JSON object
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

    if (spec.ruleJson) {
      const parsed = parseJsonObject(spec.ruleJson)
      if (parsed === undefined) {
        errors.push({ field: `${prefix}.rule_json`, message: 'Rule Criteria (JSON) must be a valid JSON object.', code: 'INVALID_JSON' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
