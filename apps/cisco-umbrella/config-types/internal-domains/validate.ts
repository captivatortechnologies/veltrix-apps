import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { MAX_DOMAIN_LENGTH, extractInternalDomainSpecs, isDomain } from './_shared'

/**
 * Validate internal-domain items: a unique, well-formed domain within the length
 * limit. description / includeAllVAs / includeAllMobileDevices are optional.
 * Static — no target access required.
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractInternalDomainSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one internal domain.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Domain is required.', code: 'required' })
    } else {
      if (spec.domain.length > MAX_DOMAIN_LENGTH) {
        errors.push({
          field: `${prefix}.domain`,
          message: `Domain must be ${MAX_DOMAIN_LENGTH} characters or fewer.`,
          code: 'too_long',
        })
      }
      if (!isDomain(spec.domain)) {
        errors.push({
          field: `${prefix}.domain`,
          message: `"${spec.domain}" is not a valid domain (e.g. corp.example.com).`,
          code: 'invalid_domain',
        })
      }
      const key = spec.domain.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.domain`,
          message: `Duplicate internal domain "${spec.domain}" — each may only be declared once per canvas.`,
          code: 'duplicate_domain',
        })
      }
      seen.add(key)
    }

    if (!spec.includeAllVAs && !spec.includeAllMobileDevices) {
      warnings.push({
        field: `${prefix}.includeAllVAs`,
        message:
          'Neither "all Virtual Appliances" nor "all mobile devices" is enabled — this internal domain may not apply anywhere.',
        code: 'no_scope',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
