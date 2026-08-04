import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractRadiusServerSpecs, RADIUS_MFA_VALUES, RADIUS_AUTH_IDP_VALUES, RADIUS_CA_SOURCE_VALUES } from './_shared'

/**
 * Validate RADIUS Server items: a non-empty, unique name, a network source IP,
 * a shared secret, and recognized enum values. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractRadiusServerSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one RADIUS Server.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'RADIUS Server name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'RADIUS Server name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate RADIUS Server "${spec.name}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (!spec.networkSourceIp) {
      errors.push({ field: `${prefix}.networkSourceIp`, message: `"${spec.name || 'server'}" requires a Network Source IP.`, code: 'EMPTY_NETWORK_SOURCE' })
    }

    if (!spec.sharedSecret) {
      errors.push({ field: `${prefix}.sharedSecret`, message: `"${spec.name || 'server'}" requires a Shared Secret.`, code: 'EMPTY_SECRET' })
    }

    if (!(RADIUS_MFA_VALUES as readonly string[]).includes(spec.mfa)) {
      errors.push({ field: `${prefix}.mfa`, message: `mfa must be one of: ${RADIUS_MFA_VALUES.join(', ')}.`, code: 'INVALID_MFA' })
    }
    if (!(RADIUS_AUTH_IDP_VALUES as readonly string[]).includes(spec.authIdp)) {
      errors.push({ field: `${prefix}.authIdp`, message: `authIdp must be one of: ${RADIUS_AUTH_IDP_VALUES.join(', ')}.`, code: 'INVALID_AUTH_IDP' })
    }
    if (!(RADIUS_CA_SOURCE_VALUES as readonly string[]).includes(spec.caSource)) {
      errors.push({ field: `${prefix}.caSource`, message: `caSource must be one of: ${RADIUS_CA_SOURCE_VALUES.join(', ')}.`, code: 'INVALID_CA_SOURCE' })
    }

    if (spec.caSource === 'BYOC' && !spec.caCert) {
      warnings.push({
        field: `${prefix}.caCert`,
        message: `"${spec.name || 'server'}" sets CA Source to "Bring Your Own Certificate" but declares no CA Certificate.`,
        code: 'MISSING_CA_CERT',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
