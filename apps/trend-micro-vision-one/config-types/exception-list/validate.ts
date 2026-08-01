import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { EXCEPTION_OBJECT_TYPES } from './_shared'

/**
 * Validate exception-list items: a known type, a non-empty value (with a light
 * per-type format check) and — when provided — a description within length. Static
 * — no target access required. The object value doubles as its identity, so a
 * duplicate value is flagged (last one wins).
 */
const SHA1_RE = /^[a-f0-9]{40}$/i
const SHA256_RE = /^[a-f0-9]{64}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE = /^https?:\/\/.+/i
const MAX_DESCRIPTION = 500

/** Light per-type value check. Returns an error message, or null when acceptable. */
function valueProblem(type: string, value: string): string | null {
  switch (type) {
    case 'url':
      return URL_RE.test(value) ? null : `URL "${value}" must be an http(s) URL.`
    case 'fileSha1':
      return SHA1_RE.test(value) ? null : `File SHA-1 "${value}" must be 40 hexadecimal characters.`
    case 'fileSha256':
      return SHA256_RE.test(value) ? null : `File SHA-256 "${value}" must be 64 hexadecimal characters.`
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
    errors.push({ field: 'items', message: 'Add at least one exception object.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const type = String(item.fields.type ?? '').trim()
    const value = String(item.fields.value ?? '').trim()
    const description = String(item.fields.description ?? '').trim()

    if (!EXCEPTION_OBJECT_TYPES.has(type)) {
      errors.push({
        field: `items[${i}].type`,
        message: `Type must be one of domain, ip, url, fileSha1, fileSha256, senderMailAddress (got "${type}").`,
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
      if (EXCEPTION_OBJECT_TYPES.has(type)) {
        const problem = valueProblem(type, value)
        if (problem) errors.push({ field: `items[${i}].value`, message: problem, code: 'INVALID_VALUE' })
      }
    }

    if (description.length > MAX_DESCRIPTION) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION} characters or fewer (got ${description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
