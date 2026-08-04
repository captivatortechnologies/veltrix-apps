import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonArray, parseJsonObject } from '../../lib/fields'
import { describePolicyNameError, policyKey, validatePolicyActionFields } from '../../lib/xrayPolicies'
import { extractOperationalRiskPolicySpecs, hasCustomCondition, MIN_RISK_LEVELS, type OperationalRiskPolicySpec } from './_shared'

const RISK_MODES = ['min_risk', 'custom'] as const

/**
 * Validate JFrog Xray operational-risk-policy items. Static — no target access required.
 *   - Policy name is required and must be safe to use as a URL path segment;
 *     duplicate names are rejected (the name is the upsert identity).
 *   - Rule name is required.
 *   - "Named minimum risk level" mode requires a valid `min_risk` (High/Medium/Low).
 *   - "Custom" mode requires at least one condition sub-field to actually be
 *     set (beyond the required AND/OR flag) — else the rule matches nothing —
 *     and a resulting risk level.
 *   - Action fields use the same validation as security/license policies,
 *     shared via lib/xrayPolicies.ts.
 *   - `criteria_json` / `actions_json` must be a JSON object; `additional_rules_json`
 *     must be a JSON array of `{ name, criteria, actions }` rule objects.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractOperationalRiskPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one operational-risk policy.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    validatePolicyIdentity(spec, prefix, errors, seen)
    validateRiskCriteria(spec, prefix, errors)
    validateActionFields(spec, prefix, errors, warnings)
    validateJsonEscapeHatches(spec, prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validatePolicyIdentity(spec: OperationalRiskPolicySpec, prefix: string, errors: ValidationError[], seen: Set<string>): void {
  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
  } else {
    const nameError = describePolicyNameError(spec.name)
    if (nameError) errors.push({ field: `${prefix}.name`, message: nameError, code: 'INVALID_NAME' })

    const key = policyKey(spec.name)
    if (seen.has(key)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate policy name "${spec.name}" — each name may only be declared once.`, code: 'DUPLICATE_NAME' })
    }
    seen.add(key)
  }

  if (!spec.ruleName) {
    errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required.', code: 'EMPTY_RULE_NAME' })
  }

  if (spec.priority !== undefined && (!Number.isInteger(spec.priority) || spec.priority < 1)) {
    errors.push({ field: `${prefix}.priority`, message: 'Priority must be a positive whole number.', code: 'INVALID_PRIORITY' })
  }
}

function validateRiskCriteria(spec: OperationalRiskPolicySpec, prefix: string, errors: ValidationError[]): void {
  if (!RISK_MODES.includes(spec.riskMode as (typeof RISK_MODES)[number])) {
    errors.push({ field: `${prefix}.risk_mode`, message: `Risk mode "${spec.riskMode}" must be one of ${RISK_MODES.join(', ')}.`, code: 'INVALID_RISK_MODE' })
    return
  }

  if (spec.riskMode === 'min_risk') {
    if (!MIN_RISK_LEVELS.includes(spec.minRisk as (typeof MIN_RISK_LEVELS)[number])) {
      errors.push({ field: `${prefix}.min_risk`, message: `Minimum risk "${spec.minRisk}" must be one of ${MIN_RISK_LEVELS.join(', ')}.`, code: 'INVALID_MIN_RISK' })
    }
    return
  }

  if (!hasCustomCondition(spec)) {
    errors.push({
      field: `${prefix}.custom_is_eol`,
      message: 'Set at least one custom condition (EOL, release age, release cadence, commits, or committers) — otherwise this rule matches nothing.',
      code: 'EMPTY_CUSTOM_CONDITION',
    })
  }
  if (!MIN_RISK_LEVELS.includes(spec.customRisk as (typeof MIN_RISK_LEVELS)[number])) {
    errors.push({ field: `${prefix}.custom_risk`, message: `Resulting risk "${spec.customRisk}" must be one of ${MIN_RISK_LEVELS.join(', ')}.`, code: 'INVALID_CUSTOM_RISK' })
  }
  if (spec.customReleaseDateMonths !== undefined && (spec.customReleaseDateMonths < 1 || spec.customReleaseDateMonths > 999)) {
    errors.push({ field: `${prefix}.custom_release_date_months`, message: 'Release age must be between 1 and 999 months.', code: 'INVALID_RELEASE_AGE' })
  }
}

/** Shared with security/license-policies via lib/xrayPolicies.ts — the actions schema is identical across policy types. */
function validateActionFields(spec: OperationalRiskPolicySpec, prefix: string, errors: ValidationError[], warnings: ValidationWarning[]): void {
  const result = validatePolicyActionFields(spec)
  result.errors.forEach((issue) => errors.push({ field: `${prefix}.${issue.fieldSuffix}`, message: issue.message, code: issue.code }))
  result.warnings.forEach((issue) => warnings.push({ field: `${prefix}.${issue.fieldSuffix}`, message: issue.message, code: issue.code }))
}

function validateJsonEscapeHatches(spec: OperationalRiskPolicySpec, prefix: string, errors: ValidationError[]): void {
  const criteria = parseJsonObject(spec.criteriaJson)
  if (!criteria.ok) {
    errors.push({ field: `${prefix}.criteria_json`, message: `Additional criteria ${criteria.error}.`, code: 'INVALID_JSON' })
  }

  const actions = parseJsonObject(spec.actionsJson)
  if (!actions.ok) {
    errors.push({ field: `${prefix}.actions_json`, message: `Additional actions ${actions.error}.`, code: 'INVALID_JSON' })
  }

  const additional = parseJsonArray(spec.additionalRulesJson)
  if (!additional.ok) {
    errors.push({ field: `${prefix}.additional_rules_json`, message: `Additional rules ${additional.error}.`, code: 'INVALID_JSON' })
    return
  }
  additional.value.forEach((entry, ri) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ field: `${prefix}.additional_rules_json[${ri}]`, message: 'Each additional rule must be a JSON object.', code: 'INVALID_RULE' })
      return
    }
    const rec = entry as Record<string, unknown>
    if (typeof rec.name !== 'string' || !rec.name.trim()) {
      errors.push({ field: `${prefix}.additional_rules_json[${ri}].name`, message: 'Each additional rule needs a "name".', code: 'INVALID_RULE' })
    }
    if (rec.criteria !== undefined && (typeof rec.criteria !== 'object' || Array.isArray(rec.criteria))) {
      errors.push({ field: `${prefix}.additional_rules_json[${ri}].criteria`, message: '"criteria" must be a JSON object.', code: 'INVALID_RULE' })
    }
    if (rec.actions !== undefined && (typeof rec.actions !== 'object' || Array.isArray(rec.actions))) {
      errors.push({ field: `${prefix}.additional_rules_json[${ri}].actions`, message: '"actions" must be a JSON object.', code: 'INVALID_RULE' })
    }
  })
}
