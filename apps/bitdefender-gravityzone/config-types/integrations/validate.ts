import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { GZ_INTEGRATION_TYPES } from '../../lib/gravityZoneApi'
import { extractIntegrationSpecs, integrationKey, parseSpecifics } from './_shared'

const VALID_TYPES = new Set<number>(GZ_INTEGRATION_TYPES.map((t) => t.value))

/**
 * Validate integration(s): a required unique name, a documented type, and
 * required, parseable Specifics JSON. Static — no target access. Type
 * immutability against a LIVE integration cannot be checked here (there is
 * no target access) — it is handled at deploy time as a non-fatal note; see
 * deploy.ts.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one integration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIntegrationSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'REQUIRED' })
    } else {
      const key = integrationKey(spec.name)
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.name`, message: `Integration "${spec.name}" is declared more than once; the last one wins.`, code: 'DUPLICATE_INTEGRATION' })
      } else {
        seen.add(key)
      }
    }

    if (!VALID_TYPES.has(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type ${spec.type} is not one of the documented values (${[...VALID_TYPES].join(', ')}).`,
        code: 'INVALID_TYPE',
      })
    }

    if (!spec.specificsRaw) {
      errors.push({ field: `${prefix}.specifics`, message: 'Specifics is required.', code: 'REQUIRED' })
    } else {
      const { error } = parseSpecifics(spec)
      if (error) errors.push({ field: `${prefix}.specifics`, message: error, code: 'INVALID_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
