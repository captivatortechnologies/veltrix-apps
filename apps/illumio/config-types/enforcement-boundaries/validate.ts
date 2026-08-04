import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractEnforcementBoundarySpecs, providerConsumerShapeError, MAX_NAME_LENGTH } from './_shared'

/**
 * Static structural validation only — no live PCE access here (that's what
 * deploy's fail-closed href resolution is for). Every field on an enforcement
 * boundary is Required in the PCE schema (providers, consumers,
 * ingress_services all need at least one entry) — confirmed against
 * resource_illumio_enforcement_boundary.go's schema (`Required: true` on all
 * three) and its own "[illumio-core_enforcement_boundary] At least one
 * ingress_service must be specified" check.
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractEnforcementBoundarySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate enforcement boundary "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.providersError) {
      errors.push({ field: `${prefix}.providersJson`, message: `Providers ${spec.providersError}`, code: 'invalid_json' })
    } else if (spec.providers.length === 0) {
      errors.push({ field: `${prefix}.providersJson`, message: 'An enforcement boundary needs at least one provider', code: 'empty_providers' })
    } else {
      spec.providers.forEach((p, pi) => {
        const err = providerConsumerShapeError(p, 'a provider')
        if (err) errors.push({ field: `${prefix}.providersJson[${pi}]`, message: err, code: 'invalid_actor' })
      })
    }

    if (spec.consumersError) {
      errors.push({ field: `${prefix}.consumersJson`, message: `Consumers ${spec.consumersError}`, code: 'invalid_json' })
    } else if (spec.consumers.length === 0) {
      errors.push({ field: `${prefix}.consumersJson`, message: 'An enforcement boundary needs at least one consumer', code: 'empty_consumers' })
    } else {
      spec.consumers.forEach((c, ci) => {
        const err = providerConsumerShapeError(c, 'a consumer')
        if (err) errors.push({ field: `${prefix}.consumersJson[${ci}]`, message: err, code: 'invalid_actor' })
      })
    }

    if (spec.servicesError) {
      errors.push({ field: `${prefix}.servicesJson`, message: `Services ${spec.servicesError}`, code: 'invalid_json' })
    } else if (spec.services.length === 0) {
      errors.push({ field: `${prefix}.servicesJson`, message: 'An enforcement boundary needs at least one ingress service', code: 'empty_services' })
    } else {
      spec.services.forEach((s, si) => {
        if (!s.name) errors.push({ field: `${prefix}.servicesJson[${si}].name`, message: 'Service name is required', code: 'required' })
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
