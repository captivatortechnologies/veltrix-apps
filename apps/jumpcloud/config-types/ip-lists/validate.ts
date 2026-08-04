import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractIpListSpecs, isPlausibleIpOrCidr } from './_shared'

/**
 * Validate IP List items: a non-empty, unique name (the logical identity) and at
 * least one plausible IP address / CIDR entry. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractIpListSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one IP List.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'IP List name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'IP List name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate IP List "${spec.name}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (spec.ips.length === 0) {
      errors.push({ field: `${prefix}.ips`, message: `"${spec.name || 'IP list'}" must declare at least one IP address or CIDR range.`, code: 'EMPTY_IPS' })
    } else {
      spec.ips.forEach((ip, j) => {
        if (!isPlausibleIpOrCidr(ip)) {
          warnings.push({
            field: `${prefix}.ips[${j}]`,
            message: `"${ip}" does not look like an IP address or CIDR range — JumpCloud will reject it if malformed.`,
            code: 'SUSPECT_IP',
          })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
