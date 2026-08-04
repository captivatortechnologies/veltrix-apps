import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SYSLOG_PROTOCOLS } from './_shared'

/**
 * Validate syslog-integration items: a non-empty name/address, a valid TCP port
 * (1-65535), and a known protocol. Static — no target access required. The name
 * doubles as the integration's identity, so a duplicate is flagged (last one
 * wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one syslog integration.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const address = String(item.fields.address ?? '').trim()
    const port = Number(item.fields.port ?? 0)
    const protocol = String(item.fields.protocol ?? '').trim().toUpperCase() || 'TCP'

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Integration "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!address) {
      errors.push({ field: `items[${i}].address`, message: 'Address (hostname or IP) is required.', code: 'EMPTY_ADDRESS' })
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push({ field: `items[${i}].port`, message: `Port must be an integer between 1 and 65535 (got "${String(item.fields.port)}").`, code: 'INVALID_PORT' })
    }

    if (!SYSLOG_PROTOCOLS.has(protocol)) {
      errors.push({ field: `items[${i}].protocol`, message: `Protocol must be one of ${[...SYSLOG_PROTOCOLS].join(', ')} (got "${protocol}").`, code: 'INVALID_PROTOCOL' })
    }

    if (protocol !== 'TLS' && String(item.fields.certificate_content ?? '').trim()) {
      warnings.push({ field: `items[${i}].certificate_content`, message: 'A certificate was provided but protocol is not TLS — it will be ignored by Cortex XDR.', code: 'CERTIFICATE_WITHOUT_TLS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
