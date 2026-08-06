import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { GZ_PUSH_SERVICE_TYPES } from '../../lib/gravityZoneApi'
import { extractPushEventSettingsSpec, parseServiceSettings } from './_shared'

const VALID_SERVICE_TYPES = new Set<string>(GZ_PUSH_SERVICE_TYPES)

/**
 * Validate the push event settings singleton: a documented Service Type,
 * required and parseable Service Settings JSON, and at least one subscribed
 * event type. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the push event settings singleton.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    warnings.push({
      field: 'items',
      message: 'Push Event Settings is a tenant-wide singleton; only the first declared item is applied.',
      code: 'SINGLETON_EXCESS',
    })
  }

  const spec = extractPushEventSettingsSpec(ctx.canvas)
  if (!spec) {
    errors.push({ field: 'items', message: 'Add the push event settings singleton.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  if (!VALID_SERVICE_TYPES.has(spec.serviceType)) {
    errors.push({
      field: 'items[0].serviceType',
      message: `Service Type "${spec.serviceType}" is not one of the documented values (${[...VALID_SERVICE_TYPES].join(', ')}).`,
      code: 'INVALID_SERVICE_TYPE',
    })
  }

  if (!spec.serviceSettingsRaw) {
    errors.push({ field: 'items[0].serviceSettings', message: 'Service Settings is required.', code: 'REQUIRED' })
  } else {
    const { error } = parseServiceSettings(spec)
    if (error) errors.push({ field: 'items[0].serviceSettings', message: error, code: 'INVALID_JSON' })
  }

  if (spec.subscribeToEventTypes.length === 0) {
    errors.push({ field: 'items[0].subscribeToEventTypes', message: 'At least one Subscribed Event Type is required.', code: 'REQUIRED' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
