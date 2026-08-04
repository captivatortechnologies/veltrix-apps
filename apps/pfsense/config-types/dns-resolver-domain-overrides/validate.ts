import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_DESCRIPTION_LENGTH, domainOverrideKey, isValidIp, isValidOverrideDomain, specFromItem } from './_shared'

/**
 * Validate domain-override items (schema-only, no live API calls):
 *   - domain required, hostname/domain/FQDN shaped, unique per canvas (case-insensitive)
 *   - ip required, valid IPv4/IPv6
 *   - tls_hostname required when forward_tls_upstream is enabled
 *   - descr length-capped
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one domain override.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.domain) {
      errors.push({ field: `${prefix}.domain`, message: 'Domain is required.', code: 'EMPTY_DOMAIN' })
    } else if (!isValidOverrideDomain(spec.domain)) {
      errors.push({ field: `${prefix}.domain`, message: `"${spec.domain}" is not a valid domain/hostname.`, code: 'INVALID_DOMAIN' })
    } else {
      const key = domainOverrideKey(spec.domain)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.domain`, message: `Duplicate domain "${spec.domain}" — each domain may only be overridden once per canvas.`, code: 'DUPLICATE_DOMAIN' })
      }
      seen.add(key)
    }

    if (!spec.ip) {
      errors.push({ field: `${prefix}.ip`, message: 'Upstream DNS Server IP is required.', code: 'EMPTY_IP' })
    } else if (!isValidIp(spec.ip)) {
      errors.push({ field: `${prefix}.ip`, message: `"${spec.ip}" is not a valid IPv4/IPv6 address.`, code: 'INVALID_IP' })
    }

    if (spec.forwardTlsUpstream && !spec.tlsHostname) {
      errors.push({ field: `${prefix}.tls_hostname`, message: 'TLS Hostname is required when "Forward TLS Upstream" is enabled.', code: 'EMPTY_TLS_HOSTNAME' })
    }
    if (!spec.forwardTlsUpstream && spec.tlsHostname) {
      warnings.push({ field: `${prefix}.tls_hostname`, message: 'TLS Hostname is ignored unless "Forward TLS Upstream" is enabled.', code: 'TLS_HOSTNAME_IGNORED' })
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
