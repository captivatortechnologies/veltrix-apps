import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractRouteSpecs, isValidCidr, routeKey, type RouteSpec } from './_shared'

/**
 * Validate OPNsense static-routes configurations: a required, unique
 * (case-insensitive) destination network in CIDR form, and a required
 * gateway NAME (not validated against OPNsense's own configured gateway
 * list — that needs a live lookup this app doesn't perform; an unresolvable
 * gateway name is left to OPNsense's own validation response at deploy time).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: RouteSpec[] = extractRouteSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.network) {
      errors.push({ field: `${prefix}.network`, message: 'Network is required', code: 'required' })
    } else {
      if (!isValidCidr(spec.network)) {
        errors.push({ field: `${prefix}.network`, message: `"${spec.network}" is not a valid network in CIDR form (e.g. 10.0.0.0/24)`, code: 'invalid_value' })
      }
      const key = routeKey(spec.network)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.network`,
          message: `Duplicate route "${spec.network}" — each destination network may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!spec.gateway) {
      errors.push({ field: `${prefix}.gateway`, message: 'Gateway is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
