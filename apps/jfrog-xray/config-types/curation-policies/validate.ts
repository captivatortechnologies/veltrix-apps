import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonArray } from '../../lib/fields'
import { invalidEmails, policyKey, POLICY_ACTIONS, SCOPES, WAIVER_REQUEST_CONFIGS, extractCurationPolicySpecs, type CurationPolicySpec } from './_shared'

/**
 * Validate JFrog Curation policy items. Static — no target access required.
 *   - Policy name and Condition ID are required; duplicate names are rejected
 *     (the name is how this app matches an existing policy — see deploy.ts).
 *   - `scope`, `policy_action` and `waiver_request_config` must be one of
 *     their documented values.
 *   - A "Specific repositories" scope requires at least one included repo; a
 *     "Specific package types" scope requires at least one included type.
 *   - Notify emails / decision owners that don't look like emails are only
 *     checked for `notify_emails` (decision owners are JFrog Access GROUP
 *     names, not emails).
 *   - `waivers_json` / `label_waivers_json` must be JSON arrays; each waiver
 *     needs its required sub-fields.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractCurationPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one curation policy.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    validateIdentity(spec, prefix, errors, seen)
    validateEnums(spec, prefix, errors)
    validateScope(spec, prefix, errors)
    validateNotifyEmails(spec, prefix, errors)
    validateWaiversJson(spec, prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateIdentity(spec: CurationPolicySpec, prefix: string, errors: ValidationError[], seen: Set<string>): void {
  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
  } else {
    const key = policyKey(spec.name)
    if (seen.has(key)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate policy name "${spec.name}" — each name may only be declared once.`, code: 'DUPLICATE_NAME' })
    }
    seen.add(key)
  }
  if (!spec.conditionId) {
    errors.push({ field: `${prefix}.condition_id`, message: 'Condition ID is required.', code: 'EMPTY_CONDITION_ID' })
  }
}

function validateEnums(spec: CurationPolicySpec, prefix: string, errors: ValidationError[]): void {
  if (!SCOPES.includes(spec.scope as (typeof SCOPES)[number])) {
    errors.push({ field: `${prefix}.scope`, message: `Scope "${spec.scope}" must be one of ${SCOPES.join(', ')}.`, code: 'INVALID_SCOPE' })
  }
  if (!POLICY_ACTIONS.includes(spec.policyAction as (typeof POLICY_ACTIONS)[number])) {
    errors.push({ field: `${prefix}.policy_action`, message: `Action "${spec.policyAction}" must be one of ${POLICY_ACTIONS.join(', ')}.`, code: 'INVALID_POLICY_ACTION' })
  }
  if (!WAIVER_REQUEST_CONFIGS.includes(spec.waiverRequestConfig as (typeof WAIVER_REQUEST_CONFIGS)[number])) {
    errors.push({
      field: `${prefix}.waiver_request_config`,
      message: `Waiver request config "${spec.waiverRequestConfig}" must be one of ${WAIVER_REQUEST_CONFIGS.join(', ')}.`,
      code: 'INVALID_WAIVER_CONFIG',
    })
  }
}

function validateScope(spec: CurationPolicySpec, prefix: string, errors: ValidationError[]): void {
  if (spec.scope === 'specific_repos' && spec.repoInclude.length === 0) {
    errors.push({ field: `${prefix}.repo_include`, message: 'At least one repository is required when scope is "Specific repositories".', code: 'EMPTY_REPO_INCLUDE' })
  }
  if (spec.scope === 'pkg_types' && spec.pkgTypesInclude.length === 0) {
    errors.push({ field: `${prefix}.pkg_types_include`, message: 'At least one package type is required when scope is "Specific package types".', code: 'EMPTY_PKG_TYPES' })
  }
}

function validateNotifyEmails(spec: CurationPolicySpec, prefix: string, errors: ValidationError[]): void {
  for (const bad of invalidEmails(spec.notifyEmails)) {
    errors.push({ field: `${prefix}.notify_emails`, message: `"${bad}" does not look like an email address.`, code: 'INVALID_EMAIL' })
  }
}

function validateWaiversJson(spec: CurationPolicySpec, prefix: string, errors: ValidationError[]): void {
  const waivers = parseJsonArray(spec.waiversJson)
  if (!waivers.ok) {
    errors.push({ field: `${prefix}.waivers_json`, message: `Package waivers ${waivers.error}.`, code: 'INVALID_JSON' })
  } else {
    waivers.value.forEach((entry, wi) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push({ field: `${prefix}.waivers_json[${wi}]`, message: 'Each waiver must be a JSON object.', code: 'INVALID_WAIVER' })
        return
      }
      const rec = entry as Record<string, unknown>
      for (const required of ['pkg_type', 'pkg_name', 'justification']) {
        if (typeof rec[required] !== 'string' || !(rec[required] as string).trim()) {
          errors.push({ field: `${prefix}.waivers_json[${wi}].${required}`, message: `Each waiver needs a "${required}".`, code: 'INVALID_WAIVER' })
        }
      }
    })
  }

  const labelWaivers = parseJsonArray(spec.labelWaiversJson)
  if (!labelWaivers.ok) {
    errors.push({ field: `${prefix}.label_waivers_json`, message: `Label waivers ${labelWaivers.error}.`, code: 'INVALID_JSON' })
  } else {
    labelWaivers.value.forEach((entry, wi) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push({ field: `${prefix}.label_waivers_json[${wi}]`, message: 'Each label waiver must be a JSON object.', code: 'INVALID_LABEL_WAIVER' })
        return
      }
      const rec = entry as Record<string, unknown>
      for (const required of ['label', 'justification']) {
        if (typeof rec[required] !== 'string' || !(rec[required] as string).trim()) {
          errors.push({ field: `${prefix}.label_waivers_json[${wi}].${required}`, message: `Each label waiver needs a "${required}".`, code: 'INVALID_LABEL_WAIVER' })
        }
      }
    })
  }
}
