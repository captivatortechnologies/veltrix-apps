import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readOptionalString, readString } from '../../lib/fields'
import { CUSTOM_DOMAIN_TYPES, TLS_POLICIES, looksLikeHostname } from './_shared'

/**
 * Validate Auth0 custom domain items: a non-empty domain that looks like a
 * bare hostname (no scheme, no path, at least one dot), a known certificate
 * type, and a known TLS policy. Static: no target access required. The domain
 * is the upsert identity, so a duplicate domain is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom domain.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const domain = readString(item.fields.domain)
    const type = readString(item.fields.type)
    const tlsPolicy = readOptionalString(item.fields.tls_policy) ?? ''

    if (!domain) {
      errors.push({ field: `items[${i}].domain`, message: 'Domain is required.', code: 'EMPTY_DOMAIN' })
    } else {
      if (!looksLikeHostname(domain)) {
        errors.push({
          field: `items[${i}].domain`,
          message: `Domain "${domain}" must be a bare hostname (no scheme, no path), e.g. login.example.com.`,
          code: 'INVALID_DOMAIN',
        })
      }
      if (seen.has(domain)) {
        warnings.push({ field: `items[${i}].domain`, message: `Domain "${domain}" is listed more than once; the last one wins.`, code: 'DUPLICATE_DOMAIN' })
      } else {
        seen.add(domain)
      }
    }

    if (!CUSTOM_DOMAIN_TYPES.has(type)) {
      errors.push({
        field: `items[${i}].type`,
        message: `Type must be one of ${[...CUSTOM_DOMAIN_TYPES].join(', ')} (got "${type}").`,
        code: 'INVALID_TYPE',
      })
    }

    if (!TLS_POLICIES.has(tlsPolicy)) {
      errors.push({
        field: `items[${i}].tls_policy`,
        message: `TLS policy must be blank, compatible, or recommended (got "${tlsPolicy}").`,
        code: 'INVALID_TLS_POLICY',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
