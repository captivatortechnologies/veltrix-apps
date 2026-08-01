import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractScheduleSpecs, parseScheduleLayers } from './_shared'

/**
 * Validate schedule items. Static — no target access required:
 *   - name is required and unique across the canvas (its reconciliation identity)
 *   - time_zone is required (PagerDuty requires an IANA zone to create a schedule)
 *   - schedule_layers must parse to a non-empty JSON array where every layer has a
 *     start, a rotation_virtual_start, a positive rotation_turn_length_seconds and
 *     at least one user shaped { user: { id, type: "user_reference" } }
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractScheduleSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one schedule.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Schedule name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(spec.name.toLowerCase())) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Schedule name "${spec.name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (!spec.timeZone) {
      errors.push({
        field: `${prefix}.time_zone`,
        message: 'A time zone is required (an IANA name such as "America/New_York").',
        code: 'EMPTY_TIME_ZONE',
      })
    }

    const parsed = parseScheduleLayers(spec.layersJson)
    if (parsed.error) {
      errors.push({ field: `${prefix}.schedule_layers`, message: `Schedule layers ${parsed.error}.`, code: 'INVALID_LAYERS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
