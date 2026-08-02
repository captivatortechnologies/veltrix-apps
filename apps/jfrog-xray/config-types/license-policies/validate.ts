import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonArray, parseJsonObject } from '../../lib/fields'
import { describePolicyNameError, policyKey, validatePolicyActionFields } from '../../lib/xrayPolicies'
import { extractLicensePolicySpecs, type LicensePolicySpec } from './_shared'

/**
 * Validate JFrog Xray license-policy items. Static — no target access required.
 *   - Policy name is required and must be safe to use as a URL path segment (it is
 *     one — `/xray/api/v2/policies/{name}`); duplicate names are rejected (the
 *     name is the upsert identity).
 *   - Rule name is required.
 *   - At least one license criterion must be set — allowed licenses, banned
 *     licenses, "flag unknown licenses", or a `criteria_json` override — else
 *     the rule matches nothing.
 *   - Action fields (grace period, notification emails) use the same
 *     validation as security-policies, shared via lib/xrayPolicies.ts.
 *   - `criteria_json` / `actions_json` must be a JSON object; `additional_rules_json`
 *     must be a JSON array of `{ name, criteria, actions }` rule objects.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractLicensePolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one license policy.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    validatePolicyIdentity(spec, prefix, errors, seen)
    validateLicenseCriteria(spec, prefix, errors)
    validateActionFields(spec, prefix, errors, warnings)
    validateJsonEscapeHatches(spec, prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validatePolicyIdentity(spec: LicensePolicySpec, prefix: string, errors: ValidationError[], seen: Set<string>): void {
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

function validateLicenseCriteria(spec: LicensePolicySpec, prefix: string, errors: ValidationError[]): void {
  const hasTypedCriteria = spec.allowedLicenses.length > 0 || spec.bannedLicenses.length > 0 || spec.allowUnknown
  if (hasTypedCriteria) return

  const parsedCriteriaJson = parseJsonObject(spec.criteriaJson)
  const hasJsonCriteria = parsedCriteriaJson.ok && Object.keys(parsedCriteriaJson.value).length > 0
  if (!hasJsonCriteria) {
    errors.push({
      field: `${prefix}.allowed_licenses`,
      message: 'Set at least one of: Allowed Licenses, Banned Licenses, or "Flag unknown licenses" — otherwise this rule matches nothing.',
      code: 'EMPTY_CRITERIA',
    })
  }
}

/** Shared with security-policies via lib/xrayPolicies.ts — the actions schema is identical across policy types. */
function validateActionFields(spec: LicensePolicySpec, prefix: string, errors: ValidationError[], warnings: ValidationWarning[]): void {
  const result = validatePolicyActionFields(spec)
  result.errors.forEach((issue) => errors.push({ field: `${prefix}.${issue.fieldSuffix}`, message: issue.message, code: issue.code }))
  result.warnings.forEach((issue) => warnings.push({ field: `${prefix}.${issue.fieldSuffix}`, message: issue.message, code: issue.code }))
}

function validateJsonEscapeHatches(spec: LicensePolicySpec, prefix: string, errors: ValidationError[]): void {
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
