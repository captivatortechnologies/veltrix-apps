import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_RE } from '../../lib/greenboneApi'

const VALID_PORT = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535

/**
 * Validate scanner items: a non-empty name, host and port, a UUID-shaped
 * credential id (this app requires an EXISTING GMP credential — see
 * _shared.ts's module doc), and a type. Static — no gvmd access required.
 * Scanner names double as the upsert identity, so a duplicate name is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scanner.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const host = String(item.fields.host ?? '').trim()
    const port = Number(item.fields.port)
    const type = String(item.fields.type ?? '').trim()
    const credentialId = String(item.fields.credentialId ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Scanner name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Scanner name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!host) {
      errors.push({ field: `items[${i}].host`, message: 'Scanner host is required.', code: 'EMPTY_HOST' })
    }

    if (!VALID_PORT(port)) {
      errors.push({ field: `items[${i}].port`, message: 'Scanner port must be an integer from 1 to 65535.', code: 'INVALID_PORT' })
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'A scanner type is required.', code: 'EMPTY_TYPE' })
    } else if (type !== '2' && type !== '3' && type !== '5') {
      errors.push({ field: `items[${i}].type`, message: `Scanner type "${type}" must be 2 (OpenVAS), 3 (CVE) or 5 (Greenbone Sensor).`, code: 'INVALID_TYPE' })
    } else if (type !== '2') {
      warnings.push({ field: `items[${i}].type`, message: `Scanner type "${type}" is not independently verified against GMP 22.5 — confirm your gvmd accepts it.`, code: 'UNVERIFIED_TYPE' })
    }

    if (!credentialId) {
      errors.push({ field: `items[${i}].credentialId`, message: 'A credential UUID is required (create_scanner requires an existing GMP credential).', code: 'EMPTY_CREDENTIAL' })
    } else if (!UUID_RE.test(credentialId)) {
      errors.push({ field: `items[${i}].credentialId`, message: `Credential "${credentialId}" must be a GMP credential UUID.`, code: 'INVALID_CREDENTIAL' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
