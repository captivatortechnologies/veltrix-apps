import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeHostname } from './_shared'

/**
 * Validate the Syslog Configuration singleton: exactly one target, a non-empty
 * hostname and a valid port. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add a syslog target.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Syslog Configuration is a cluster singleton — declare exactly one target.', code: 'SINGLETON' })
  }

  items.forEach((item, i) => {
    const hostname = normalizeHostname(item.fields.hostname)
    if (!hostname) {
      errors.push({ field: `items[${i}].hostname`, message: 'Syslog server hostname/IP is required.', code: 'EMPTY_HOSTNAME' })
    }

    const rawPort = item.fields.port
    const port = typeof rawPort === 'number' ? rawPort : parseInt(String(rawPort ?? ''), 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push({ field: `items[${i}].port`, message: 'Port must be a whole number between 1 and 65535.', code: 'INVALID_PORT' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
