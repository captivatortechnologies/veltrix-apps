import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { domainOverrideKey, extractDomainOverrideSpecs, type DomainOverrideSpec } from './_shared'

/**
 * Validate OPNsense unbound-domain-overrides configurations: a required,
 * unique (case-insensitive) domain, and a required server to forward to.
 * This app's OWN canvas requires `domain` even though the underlying model
 * field is not required — see _shared.ts's module doc on the "catch-all"
 * blank-domain use case this app does not support.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: DomainOverrideSpec[] = extractDomainOverrideSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Domain is required', code: 'required' })
    } else {
      const key = domainOverrideKey(spec.domain)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.domain`,
          message: `Duplicate domain "${spec.domain}" — each domain may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!spec.server) {
      errors.push({ field: `${prefix}.server`, message: 'Server (the DNS server to forward to) is required', code: 'required' })
    }
    if (spec.port != null && (spec.port < 1 || spec.port > 65535)) {
      errors.push({ field: `${prefix}.port`, message: 'Port must be between 1 and 65535', code: 'invalid_value' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
