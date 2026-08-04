import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MIN_SECRET_LENGTH, extractTunnelSpecs } from './_shared'

/**
 * Validate tunnel items: a unique non-empty name within the length limit, a
 * non-empty device type, and a PSK secret (warns, rather than errors, below a
 * defensive minimum length — Umbrella's own enforced minimum is not
 * independently confirmed). Static — no target access required.
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTunnelSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one tunnel.', code: 'EMPTY' })
  }

  const seenNames = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate tunnel "${spec.name}" — each may only be declared once per canvas.`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (!spec.deviceType) {
      errors.push({ field: `${prefix}.deviceType`, message: 'Device type is required.', code: 'required' })
    }

    if (!spec.pskSecret) {
      errors.push({ field: `${prefix}.pskSecret`, message: 'A PSK secret is required.', code: 'required' })
    } else if (spec.pskSecret.length < MIN_SECRET_LENGTH) {
      warnings.push({
        field: `${prefix}.pskSecret`,
        message: `The PSK secret is shorter than ${MIN_SECRET_LENGTH} characters — consider a stronger shared secret.`,
        code: 'weak_secret',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
