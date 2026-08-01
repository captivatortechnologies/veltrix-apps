import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORK_LIST_TYPES, normalizeType, parseElements } from './_shared'

/**
 * Validate Network List items: a non-empty name (≤100 chars), a known type
 * (IP/GEO), an optional description (≤255 chars) and well-formed elements —
 * IP addresses / CIDR blocks for IP lists, two-letter country codes for GEO
 * lists. Static — no target access required. The list NAME is the identity, so a
 * duplicate name is flagged (last one wins).
 */

// IPv4 (optionally /0-32). IPv6 is validated loosely (hex groups + optional /mask).
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(3[0-2]|[12]?\d))?$/
const IPV6_RE = /^[0-9a-fA-F:]+(\/(12[0-8]|1[01]\d|\d{1,2}))?$/
const GEO_RE = /^[A-Z]{2}$/

function isValidIpElement(value: string): boolean {
  const m = IPV4_RE.exec(value)
  if (m) return [m[1], m[2], m[3], m[4]].every((o) => Number(o) <= 255)
  return value.includes(':') && IPV6_RE.test(value)
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one network list.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const rawType = String(item.fields.type ?? '').trim().toUpperCase()
    const type = normalizeType(item.fields.type)
    const elements = parseElements(item.fields.list, type)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'List name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 100) {
      errors.push({ field: `items[${i}].name`, message: 'List name must be 100 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `List name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!NETWORK_LIST_TYPES.has(rawType)) {
      errors.push({ field: `items[${i}].type`, message: `Type must be IP or GEO (got "${rawType || '(empty)'}").`, code: 'INVALID_TYPE' })
    }

    const description = String(item.fields.description ?? '')
    if (description.length > 255) {
      errors.push({ field: `items[${i}].description`, message: 'Description must be 255 characters or fewer.', code: 'DESCRIPTION_TOO_LONG' })
    }

    if (elements.length === 0) {
      warnings.push({ field: `items[${i}].list`, message: `List "${name || i}" has no elements — it will be created/updated empty.`, code: 'EMPTY_LIST' })
    }

    elements.forEach((el, j) => {
      if (type === 'GEO') {
        if (!GEO_RE.test(el)) {
          errors.push({ field: `items[${i}].list[${j}]`, message: `GEO element "${el}" must be a two-letter country code (e.g. US).`, code: 'INVALID_GEO' })
        }
      } else if (!isValidIpElement(el)) {
        errors.push({ field: `items[${i}].list[${j}]`, message: `IP element "${el}" is not a valid IP address or CIDR block.`, code: 'INVALID_IP' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
