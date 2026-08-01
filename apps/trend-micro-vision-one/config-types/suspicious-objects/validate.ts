import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { OBJECT_TYPES, SCAN_ACTIONS, RISK_LEVELS } from './_shared'

/**
 * Validate suspicious-object items: a known type, a non-empty value (with a light
 * per-type format check), a known scan action + risk level, and — when provided —
 * a positive-integer daysToExpiration. Static — no target access required. The
 * object value doubles as its identity, so a duplicate value is flagged (last one
 * wins).
 */
const SHA1_RE = /^[a-f0-9]{40}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE = /^https?:\/\/.+/i

/** Light per-type value check. Returns an error message, or null when acceptable. */
function valueProblem(type: string, value: string): string | null {
  switch (type) {
    case 'url':
      return URL_RE.test(value) ? null : `URL "${value}" must be an http(s) URL.`
    case 'fileSha1':
      return SHA1_RE.test(value) ? null : `File SHA-1 "${value}" must be 40 hexadecimal characters.`
    case 'senderMailAddress':
      return EMAIL_RE.test(value) ? null : `Sender mail address "${value}" is not a valid email address.`
    default:
      return null // domain / ip — accepted as free text (Vision One validates server-side)
  }
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one suspicious object.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const type = String(item.fields.type ?? '').trim()
    const value = String(item.fields.value ?? '').trim()
    const scanAction = String(item.fields.scanAction ?? '').trim()
    const riskLevel = String(item.fields.riskLevel ?? '').trim()
    const days = String(item.fields.daysToExpiration ?? '').trim()

    if (!OBJECT_TYPES.has(type)) {
      errors.push({
        field: `items[${i}].type`,
        message: `Type must be one of domain, ip, url, fileSha1, senderMailAddress (got "${type}").`,
        code: 'INVALID_TYPE',
      })
    }

    if (!value) {
      errors.push({ field: `items[${i}].value`, message: 'Object value is required.', code: 'EMPTY_VALUE' })
    } else {
      const key = value.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].value`, message: `Object ${value} is listed more than once; the last one wins.`, code: 'DUPLICATE_VALUE' })
      } else {
        seen.add(key)
      }
      if (OBJECT_TYPES.has(type)) {
        const problem = valueProblem(type, value)
        if (problem) errors.push({ field: `items[${i}].value`, message: problem, code: 'INVALID_VALUE' })
      }
    }

    if (!SCAN_ACTIONS.has(scanAction)) {
      errors.push({ field: `items[${i}].scanAction`, message: `Scan action must be block or log (got "${scanAction}").`, code: 'INVALID_SCAN_ACTION' })
    }

    if (!RISK_LEVELS.has(riskLevel)) {
      errors.push({ field: `items[${i}].riskLevel`, message: `Risk level must be one of high, medium, low (got "${riskLevel}").`, code: 'INVALID_RISK_LEVEL' })
    }

    if (days && !/^[0-9]+$/.test(days)) {
      errors.push({ field: `items[${i}].daysToExpiration`, message: `Days to expiration must be a positive whole number (got "${days}").`, code: 'INVALID_EXPIRATION' })
    } else if (days && Number(days) <= 0) {
      errors.push({ field: `items[${i}].daysToExpiration`, message: 'Days to expiration must be greater than zero.', code: 'INVALID_EXPIRATION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
