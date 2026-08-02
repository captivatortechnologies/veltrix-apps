import type { PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonObject } from '../../lib/fields'
import { hasObjectiveFilter, extractIgnoreRuleSpecs, type IgnoreRuleSpec } from './_shared'

/**
 * Validate JFrog Xray ignore-rule items. Static — no target access required.
 *   - `notes` is required (Xray requires it; it also doubles as this item's
 *     canvas label since ignore rules have no user-chosen name).
 *   - `expires_at`, when set, must parse as a valid timestamp AND be in the
 *     future — Xray rejects a past expiry.
 *   - At least one OBJECTIVE filter is required: a vulnerability id, a CVE, a
 *     license, or an equivalent key via the JSON escape valve — a rule with
 *     only scope filters (watches/policies/components/…) and no objective
 *     filter would suppress nothing.
 *   - `additional_filters_json` must be a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractIgnoreRuleSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ignore rule.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    validateNotes(spec, prefix, errors)
    validateExpiry(spec, prefix, errors)
    validateObjectiveFilter(spec, prefix, errors)
    validateAdditionalFiltersJson(spec, prefix, errors)
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateNotes(spec: IgnoreRuleSpec, prefix: string, errors: ValidationError[]): void {
  if (!spec.notes) {
    errors.push({ field: `${prefix}.notes`, message: 'Notes are required.', code: 'EMPTY_NOTES' })
  }
}

function validateExpiry(spec: IgnoreRuleSpec, prefix: string, errors: ValidationError[]): void {
  if (!spec.expiresAt) return
  const parsed = Date.parse(spec.expiresAt)
  if (Number.isNaN(parsed)) {
    errors.push({ field: `${prefix}.expires_at`, message: `"${spec.expiresAt}" is not a valid RFC 3339 timestamp.`, code: 'INVALID_EXPIRY' })
    return
  }
  if (parsed <= Date.now()) {
    errors.push({ field: `${prefix}.expires_at`, message: 'Expiry must be in the future.', code: 'EXPIRY_IN_PAST' })
  }
}

function validateObjectiveFilter(spec: IgnoreRuleSpec, prefix: string, errors: ValidationError[]): void {
  if (!hasObjectiveFilter(spec)) {
    errors.push({
      field: `${prefix}.vulnerability_ids`,
      message: 'At least one objective filter is required — a Vulnerability/Xray ID, a CVE, a License, or an equivalent key in Additional Filters (JSON).',
      code: 'EMPTY_OBJECTIVE_FILTER',
    })
  }
}

function validateAdditionalFiltersJson(spec: IgnoreRuleSpec, prefix: string, errors: ValidationError[]): void {
  const parsed = parseJsonObject(spec.additionalFiltersJson)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.additional_filters_json`, message: `Additional filters ${parsed.error}.`, code: 'INVALID_JSON' })
  }
}
