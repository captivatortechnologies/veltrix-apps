import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_DESCRIPTION_LENGTH, hostOverrideKey, isValidHostLabel, isValidIp, isValidOverrideDomain, specFromItem } from './_shared'

/**
 * Validate host-override items (schema-only, no live API calls):
 *   - host: optional (blank overrides the bare domain), hostname-label shaped when set
 *   - domain required, domain-shaped
 *   - host+domain unique per canvas (case-insensitive)
 *   - ip: at least one required, each a valid IPv4/IPv6
 *   - descr length-capped
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one host override.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (spec.host && !isValidHostLabel(spec.host)) {
      errors.push({ field: `${prefix}.host`, message: `"${spec.host}" is not a valid hostname label.`, code: 'INVALID_HOST' })
    }
    if (!spec.host) {
      warnings.push({ field: `${prefix}.host`, message: 'Host is blank — this overrides the bare Domain value itself, not a subdomain of it.', code: 'BLANK_HOST_OVERRIDES_DOMAIN' })
    }

    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Domain is required.', code: 'EMPTY_DOMAIN' })
    } else if (!isValidOverrideDomain(spec.domain)) {
      errors.push({ field: `${prefix}.domain`, message: `"${spec.domain}" is not a valid domain.`, code: 'INVALID_DOMAIN' })
    }

    if (spec.domain) {
      const key = hostOverrideKey(spec.host, spec.domain)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.host`,
          message: `Duplicate host+domain "${spec.host || '(blank)'}"+"${spec.domain}" — each combination may only be declared once per canvas.`,
          code: 'DUPLICATE_HOST_DOMAIN',
        })
      }
      seen.add(key)
    }

    if (spec.ip.length === 0) {
      errors.push({ field: `${prefix}.ip`, message: 'At least one IP address is required.', code: 'EMPTY_IP' })
    } else {
      spec.ip.forEach((ip, j) => {
        if (!isValidIp(ip)) {
          errors.push({ field: `${prefix}.ip[${j}]`, message: `"${ip}" is not a valid IPv4/IPv6 address.`, code: 'INVALID_IP' })
        }
      })
    }

    if (spec.descr.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.descr`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.descr.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
