import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate firewall-access items: a host group, a valid host (IP / IPv6 /
 * hostname — NOT a CIDR range), and a known action. Static — no target access
 * required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one firewall access entry.', code: 'EMPTY' })
  }

  const seen = new Map<string, string>()
  items.forEach((item, i) => {
    const group = String(item.fields.group ?? '').trim()
    const host = String(item.fields.host ?? '').trim()
    const action = String(item.fields.action ?? '')

    if (!group) {
      errors.push({ field: `items[${i}].group`, message: 'Host group is required.', code: 'MISSING_GROUP' })
    }

    if (host.includes('/')) {
      errors.push({ field: `items[${i}].host`, message: `Host must be a single IP, IPv6 or hostname, not a CIDR range (got "${host}").`, code: 'CIDR_UNSUPPORTED' })
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(host)) {
      errors.push({ field: `items[${i}].host`, message: `Host is not a valid IP, IPv6 or hostname (got "${host}").`, code: 'INVALID_HOST' })
    }

    const key = `${group}|${host}`
    if (host && seen.has(key) && seen.get(key) !== action) {
      warnings.push({ field: `items[${i}].host`, message: `${host} in group ${group} is listed with conflicting actions; the last one wins.`, code: 'CONFLICTING_HOST' })
    } else if (host && seen.has(key)) {
      warnings.push({ field: `items[${i}].host`, message: `${host} in group ${group} is listed more than once.`, code: 'DUPLICATE_HOST' })
    } else if (host) {
      seen.set(key, action)
    }

    if (action !== 'include' && action !== 'exclude') {
      errors.push({ field: `items[${i}].action`, message: `Action must be "include" or "exclude" (got "${action}").`, code: 'INVALID_ACTION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
