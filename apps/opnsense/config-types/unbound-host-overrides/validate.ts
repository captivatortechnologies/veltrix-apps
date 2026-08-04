import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractHostOverrideSpecs, hostOverrideKey, isValidRecordType, type HostOverrideSpec } from './_shared'

/**
 * Validate OPNsense unbound-host-overrides configurations: required
 * hostname + domain (their composite forms this app's identity, deduped
 * case-insensitively per canvas — see _shared.ts), a supported record type,
 * and the model's own SetIfConstraint-equivalent per-type requirements:
 * `server` for A/AAAA, `mxprio`+`mx` for MX, `txtdata` for TXT.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: HostOverrideSpec[] = extractHostOverrideSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.hostname) {
      errors.push({ field: `${prefix}.hostname`, message: 'Hostname is required', code: 'required' })
    }
    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Domain is required', code: 'required' })
    }
    if (spec.hostname && spec.domain) {
      const key = hostOverrideKey(spec.hostname, spec.domain)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.hostname`,
          message: `Duplicate host override "${spec.hostname}.${spec.domain}" — each hostname+domain pair may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!isValidRecordType(spec.rr)) {
      errors.push({ field: `${prefix}.rr`, message: `Record type must be one of A, AAAA, MX, TXT (got "${spec.rr}")`, code: 'invalid_value' })
    }
    if ((spec.rr === 'A' || spec.rr === 'AAAA') && !spec.server) {
      errors.push({ field: `${prefix}.server`, message: `IP address is required for a ${spec.rr} record`, code: 'required' })
    }
    if (spec.rr === 'MX') {
      if (spec.mxprio == null) {
        errors.push({ field: `${prefix}.mxprio`, message: 'MX priority is required for an MX record', code: 'required' })
      }
      if (!spec.mx) {
        errors.push({ field: `${prefix}.mx`, message: 'MX host is required for an MX record', code: 'required' })
      }
    }
    if (spec.rr === 'TXT' && !spec.txtdata) {
      errors.push({ field: `${prefix}.txtdata`, message: 'TXT data is required for a TXT record', code: 'required' })
    }
    if (spec.ttl != null && (spec.ttl < 0 || spec.ttl > 2147483647)) {
      errors.push({ field: `${prefix}.ttl`, message: 'TTL must be between 0 and 2147483647', code: 'invalid_value' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
