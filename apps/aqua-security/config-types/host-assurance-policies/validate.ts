import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CVSS_SEVERITIES, extractAssurancePolicySpecs } from '../lib/assurancePolicy'

/**
 * Validate host-assurance-policy items: a non-empty unique name, at least one
 * application scope, a valid CVSS severity, and CVSS/score values in range.
 * Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractAssurancePolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one host assurance policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 128) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name must be 128 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else if (seen.has(spec.name)) {
      warnings.push({ field: `items[${i}].name`, message: `Policy name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(spec.name)
    }

    if (spec.applicationScopes.length === 0) {
      errors.push({ field: `items[${i}].applicationScopes`, message: 'At least one application scope is required.', code: 'EMPTY_SCOPES' })
    }

    if (spec.cvssSeverityEnabled && !(CVSS_SEVERITIES as readonly string[]).includes(spec.cvssSeverity)) {
      errors.push({
        field: `items[${i}].cvssSeverity`,
        message: `Severity must be one of ${CVSS_SEVERITIES.join(', ')} (got "${spec.cvssSeverity}").`,
        code: 'INVALID_SEVERITY',
      })
    }

    if (spec.maximumScoreEnabled && (spec.maximumScore < 0 || spec.maximumScore > 10)) {
      errors.push({ field: `items[${i}].maximumScore`, message: 'Maximum CVSS score must be between 0 and 10.', code: 'INVALID_SCORE' })
    }

    if (spec.enforceAfterDays < 0) {
      errors.push({ field: `items[${i}].enforceAfterDays`, message: 'Enforce-after days cannot be negative.', code: 'INVALID_DAYS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
