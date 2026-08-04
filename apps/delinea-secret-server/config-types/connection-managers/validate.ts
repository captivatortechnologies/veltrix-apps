import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CONNECTOR_TRANSPORT_TYPES } from './_shared'

/**
 * Validate connection-manager items: a non-empty name (its identity), a
 * non-empty hostname, a supported transport type, and an SSL certificate
 * thumbprint whenever "Use SSL" is on (Secret Server rejects SSL without one).
 * Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one connection manager.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const f = item.fields ?? {}
    const name = String(f.name ?? '').trim()
    const hostname = String(f.hostname ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 255) {
      errors.push({ field: `items[${i}].name`, message: `Name "${name}" exceeds 255 characters.`, code: 'NAME_TOO_LONG' })
    }

    if (!hostname) {
      errors.push({ field: `items[${i}].hostname`, message: 'Hostname is required.', code: 'EMPTY_HOSTNAME' })
    }

    const transport = String(f.transportType ?? 'MemoryMq')
    if (!(CONNECTOR_TRANSPORT_TYPES as readonly string[]).includes(transport)) {
      errors.push({
        field: `items[${i}].transportType`,
        message: `Transport type must be one of ${CONNECTOR_TRANSPORT_TYPES.join(', ')}.`,
        code: 'INVALID_TRANSPORT_TYPE',
      })
    }

    const useSsl = f.useSsl === true || String(f.useSsl).toLowerCase() === 'true'
    const thumbprint = String(f.sslCertificateThumbprint ?? '').trim()
    if (useSsl && !thumbprint) {
      errors.push({
        field: `items[${i}].sslCertificateThumbprint`,
        message: 'SSL certificate thumbprint is required when Use SSL is on.',
        code: 'MISSING_SSL_THUMBPRINT',
      })
    }

    if (name) {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Connection manager "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_CONNECTOR',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
