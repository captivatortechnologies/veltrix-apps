import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { connectorKey, extractConnectorSpecs } from './_shared'

/**
 * Validate Twingate Connector configurations: name and Remote Network name
 * are required; name must be unique across the canvas (case-insensitive).
 * Purely static: no live Twingate calls.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractConnectorSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.itemName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Connector name is required', code: 'required' })
    }
    if (!spec.remoteNetworkName) {
      errors.push({ field: `${prefix}.remote_network_name`, message: 'Remote Network name is required', code: 'required' })
    }

    if (spec.name) {
      const key = connectorKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Connector "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_connector',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
