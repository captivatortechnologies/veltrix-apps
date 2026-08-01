import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractServiceSpecs, VALID_ALERT_CREATION } from './_shared'

/**
 * Validate service items. Static — no target access required:
 *   - name is required and unique across the canvas (its reconciliation identity)
 *   - escalation_policy (the referenced policy NAME) is required; deploy resolves
 *     it to an id against the live account
 *   - auto_resolve_timeout / acknowledgement_timeout, when supplied, must be
 *     non-negative integers (seconds)
 *   - alert_creation, when supplied, must be create_incidents or
 *     create_alerts_and_incidents
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractServiceSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one service.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Service name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(spec.name.toLowerCase())) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Service name "${spec.name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (!spec.escalationPolicyName) {
      errors.push({
        field: `${prefix}.escalation_policy`,
        message: 'An escalation policy name is required — every service must reference one.',
        code: 'EMPTY_ESCALATION_POLICY',
      })
    }

    for (const [key, value] of [
      ['auto_resolve_timeout', spec.autoResolveTimeout],
      ['acknowledgement_timeout', spec.acknowledgementTimeout],
    ] as const) {
      if (value !== null && (Number.isNaN(value) || !Number.isInteger(value) || value < 0)) {
        errors.push({
          field: `${prefix}.${key}`,
          message: `${key} must be a non-negative integer number of seconds.`,
          code: 'INVALID_TIMEOUT',
        })
      }
    }

    if (spec.alertCreation && !VALID_ALERT_CREATION.has(spec.alertCreation)) {
      errors.push({
        field: `${prefix}.alert_creation`,
        message: `alert_creation must be one of ${[...VALID_ALERT_CREATION].join(' / ')}.`,
        code: 'INVALID_ALERT_CREATION',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
