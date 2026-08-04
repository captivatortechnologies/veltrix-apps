import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractServiceOrchestrationSpecs, parseCatchAll, parseOrchestrationSets } from './_shared'

/**
 * Validate service orchestration items. Static — no target access required:
 *   - service (the target Service's NAME) is required and unique across the
 *     canvas — reconciliation is per-service, so listing the same service twice
 *     would have the second item silently overwrite the first
 *   - sets must parse to a non-empty JSON array of { id, rules? } objects
 *   - catch_all, when supplied, must parse to a JSON object with an "actions"
 *     object (a blank value defaults to {"actions":{}})
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractServiceOrchestrationSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one service orchestration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.service) {
      errors.push({ field: `${prefix}.service`, message: 'A target service name is required.', code: 'EMPTY_SERVICE' })
    } else if (seen.has(spec.service.toLowerCase())) {
      warnings.push({
        field: `${prefix}.service`,
        message: `Service "${spec.service}" is targeted by more than one item; the last one wins (reconciliation is per-service).`,
        code: 'DUPLICATE_SERVICE',
      })
    } else {
      seen.add(spec.service.toLowerCase())
    }

    const sets = parseOrchestrationSets(spec.setsJson)
    if (sets.error) {
      errors.push({ field: `${prefix}.sets`, message: `Sets ${sets.error}.`, code: 'INVALID_SETS' })
    }

    const catchAll = parseCatchAll(spec.catchAllJson)
    if (catchAll.error) {
      errors.push({ field: `${prefix}.catch_all`, message: `Catch-all ${catchAll.error}.`, code: 'INVALID_CATCH_ALL' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
