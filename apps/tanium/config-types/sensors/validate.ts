import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseAdditionalQueries, parseNonNegativeInt } from './_shared'

/**
 * Validate sensor items: a non-empty name and a primary query (platform, script
 * type and script), plus a well-shaped "additional queries" JSON and a
 * non-negative max-age when supplied. Static — no target access required. The
 * name is the sensor identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sensor.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const platform = String(item.fields.platform ?? '').trim()
    const scriptType = String(item.fields.scriptType ?? '').trim()
    const script = String(item.fields.script ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Sensor name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Sensor name ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    if (!platform) {
      errors.push({ field: `items[${i}].platform`, message: 'Target platform is required.', code: 'EMPTY_PLATFORM' })
    }
    if (!scriptType) {
      errors.push({ field: `items[${i}].scriptType`, message: 'Script type is required.', code: 'EMPTY_SCRIPT_TYPE' })
    }
    if (!script) {
      errors.push({ field: `items[${i}].script`, message: 'Sensor script is required.', code: 'EMPTY_SCRIPT' })
    }

    const additional = parseAdditionalQueries(item.fields.additionalQueriesJson)
    if (additional.error) {
      errors.push({ field: `items[${i}].additionalQueriesJson`, message: additional.error, code: 'INVALID_ADDITIONAL_QUERIES' })
    }

    const maxAge = parseNonNegativeInt(item.fields.maxAgeSeconds)
    if (maxAge.error) {
      errors.push({ field: `items[${i}].maxAgeSeconds`, message: `Max age ${maxAge.error}.`, code: 'INVALID_MAX_AGE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
