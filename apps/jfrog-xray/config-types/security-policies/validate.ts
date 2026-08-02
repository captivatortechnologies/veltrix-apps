import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { looksLikeEmail, parseJsonArray, parseJsonObject } from '../../lib/fields'
import { extractPolicySpecs, MIN_SEVERITIES, policyKey, type PolicySpec } from './_shared'

/**
 * Validate JFrog Xray security-policy items. Static — no target access required.
 *   - Policy name is required and must be safe to use as a URL path segment (it is
 *     one — `/xray/api/v2/policies/{name}`); duplicate names are rejected (the
 *     name is the upsert identity).
 *   - Rule name is required.
 *   - Exactly one severity-gate mode: a named `min_severity`, or a CVSS range
 *     (both bounds present, 0.0–10.0, from <= to) when "Use CVSS range" is on.
 *   - `malicious_package` and `fix_version_dependant` are mutually exclusive
 *     (per JFrog's own policy schema — a malicious-package match has no fix version).
 *   - `build_failure_grace_period_days` must be a non-negative integer.
 *   - Each declared notification email must look like an email address.
 *   - `criteria_json` / `actions_json` must be a JSON object; `additional_rules_json`
 *     must be a JSON array of `{ name, criteria, actions }` rule objects.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one security policy.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    validatePolicyIdentity(spec, prefix, errors, seen)
    validateSeverityGate(spec, prefix, errors)
    validateCriteriaFlags(spec, prefix, errors)
    validateActionFields(spec, prefix, errors, warnings)
    validateJsonEscapeHatches(spec, prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validatePolicyIdentity(spec: PolicySpec, prefix: string, errors: ValidationError[], seen: Set<string>): void {
  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
  } else {
    // The name is the URL path segment for every read/write/delete call —
    // a slash would silently address the wrong (nested) path.
    if (/[/\\]/.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Policy name "${spec.name}" must not contain "/" or "\\" — it is used directly in the API URL.`,
        code: 'INVALID_NAME',
      })
    }
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

function validateSeverityGate(spec: PolicySpec, prefix: string, errors: ValidationError[]): void {
  if (spec.useCvssRange) {
    if (spec.cvssFrom === undefined || spec.cvssTo === undefined) {
      errors.push({
        field: `${prefix}.cvss_from`,
        message: 'A CVSS range requires both a "From" and a "To" score.',
        code: 'INCOMPLETE_CVSS_RANGE',
      })
      return
    }
    for (const [key, value] of [['cvss_from', spec.cvssFrom] as const, ['cvss_to', spec.cvssTo] as const]) {
      if (value < 0 || value > 10) {
        errors.push({ field: `${prefix}.${key}`, message: `CVSS score ${value} must be between 0.0 and 10.0.`, code: 'INVALID_CVSS_SCORE' })
      }
    }
    if (spec.cvssFrom > spec.cvssTo) {
      errors.push({
        field: `${prefix}.cvss_from`,
        message: `CVSS "From" (${spec.cvssFrom}) must not be greater than "To" (${spec.cvssTo}).`,
        code: 'INVALID_CVSS_RANGE',
      })
    }
  } else if (!MIN_SEVERITIES.includes(spec.minSeverity as (typeof MIN_SEVERITIES)[number])) {
    errors.push({
      field: `${prefix}.min_severity`,
      message: `Minimum severity "${spec.minSeverity}" must be one of ${MIN_SEVERITIES.join(', ')}.`,
      code: 'INVALID_SEVERITY',
    })
  }
}

function validateCriteriaFlags(spec: PolicySpec, prefix: string, errors: ValidationError[]): void {
  if (spec.maliciousPackage && spec.fixVersionDependant) {
    errors.push({
      field: `${prefix}.fix_version_dependant`,
      message: '"Malicious package" and "Requires a fix version" cannot both be enabled — a malicious-package match has no fix version.',
      code: 'CONFLICTING_CRITERIA',
    })
  }
}

function validateActionFields(spec: PolicySpec, prefix: string, errors: ValidationError[], warnings: ValidationWarning[]): void {
  if (
    spec.buildFailureGracePeriodDays !== undefined &&
    (!Number.isInteger(spec.buildFailureGracePeriodDays) || spec.buildFailureGracePeriodDays < 0)
  ) {
    errors.push({
      field: `${prefix}.build_failure_grace_period_days`,
      message: 'Build failure grace period must be a non-negative whole number of days.',
      code: 'INVALID_GRACE_PERIOD',
    })
  }
  if (spec.buildFailureGracePeriodDays !== undefined && !spec.failBuild) {
    warnings.push({
      field: `${prefix}.build_failure_grace_period_days`,
      message: 'A build failure grace period has no effect unless "Fail build" is enabled.',
      code: 'GRACE_PERIOD_WITHOUT_FAIL_BUILD',
    })
  }

  spec.mails.forEach((mail, mi) => {
    if (!looksLikeEmail(mail)) {
      errors.push({ field: `${prefix}.mails[${mi}]`, message: `"${mail}" does not look like an email address.`, code: 'INVALID_EMAIL' })
    }
  })

  if (spec.createTicketEnabled) {
    warnings.push({
      field: `${prefix}.create_ticket_enabled`,
      message: 'Ticket creation requires a Jira integration already configured in Xray (Administration > Integrations).',
      code: 'TICKET_REQUIRES_JIRA',
    })
  }
}

function validateJsonEscapeHatches(spec: PolicySpec, prefix: string, errors: ValidationError[]): void {
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
