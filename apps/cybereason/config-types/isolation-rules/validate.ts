import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { DIRECTIONS, isValidIpv4, normalizeDirection, ruleIdentity } from './_shared'

/**
 * Validate isolation-rule items: a valid IPv4 ipAddressString, a known direction
 * (ALL / INCOMING / OUTGOING), and an integer port in 0-65535 when provided. The
 * composite (ip + direction + port) is the upsert identity, so a duplicate is
 * flagged (last one wins). Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one isolation rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const ip = String(item.fields.ipAddressString ?? '').trim()
    const direction = normalizeDirection(item.fields.direction)
    const rawPort = item.fields.port

    if (!ip) {
      errors.push({ field: `items[${i}].ipAddressString`, message: 'IP address is required.', code: 'EMPTY_IP' })
    } else if (!isValidIpv4(ip)) {
      errors.push({ field: `items[${i}].ipAddressString`, message: `"${ip}" is not a valid IPv4 address.`, code: 'INVALID_IP' })
    }

    if (!DIRECTIONS.has(direction)) {
      errors.push({
        field: `items[${i}].direction`,
        message: `Direction must be one of ALL, INCOMING, OUTGOING (got "${direction}").`,
        code: 'INVALID_DIRECTION',
      })
    }

    if (rawPort !== '' && rawPort !== null && rawPort !== undefined) {
      const n = Number(rawPort)
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        errors.push({
          field: `items[${i}].port`,
          message: `Port must be an integer between 0 and 65535 (0 = any port). Got "${String(rawPort)}".`,
          code: 'INVALID_PORT',
        })
      }
    }

    if (ip && isValidIpv4(ip) && DIRECTIONS.has(direction)) {
      const id = ruleIdentity({ ipAddressString: ip, direction, port: rawPort })
      if (seen.has(id)) {
        warnings.push({ field: `items[${i}].ipAddressString`, message: `Rule ${id} is listed more than once; the last one wins.`, code: 'DUPLICATE_RULE' })
      } else {
        seen.add(id)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
