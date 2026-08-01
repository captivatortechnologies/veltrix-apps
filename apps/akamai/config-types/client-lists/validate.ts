import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  CLIENT_LIST_TYPES,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  normalizeClientListType,
  parseGroupId,
  parseItemValues,
  parseTags,
} from './_shared'

/**
 * Validate Client List items: a non-empty name (≤255 chars), a known type, a
 * contract + numeric group (both required to create a list), at most 5 tags of
 * ≤256 chars, and — for the types with a well-defined element format (IP / GEO /
 * ASN) — well-formed entries. Entries for the richer types (TLS fingerprints,
 * file hashes, user IDs, domains, header name/value) are accepted as-is; only
 * their non-emptiness is guaranteed by the parser. Static — no target access.
 * The list NAME is the identity, so a duplicate name is flagged (last one wins).
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(3[0-2]|[12]?\d))?$/
const IPV6_RE = /^[0-9a-fA-F:]+(\/(12[0-8]|1[01]\d|\d{1,2}))?$/
const GEO_RE = /^[A-Z]{2}$/
const ASN_RE = /^(AS)?\d{1,10}$/i

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
    errors.push({ field: 'items', message: 'Add at least one client list.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const rawType = String(item.fields.type ?? '').trim().toUpperCase()
    const type = normalizeClientListType(item.fields.type)
    const tags = parseTags(item.fields.tags)
    const contractId = String(item.fields.contractId ?? '').trim()
    const groupId = parseGroupId(item.fields.groupId)
    const values = parseItemValues(item.fields.items, type)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'List name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 255) {
      errors.push({ field: `items[${i}].name`, message: 'List name must be 255 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `List name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!CLIENT_LIST_TYPES.has(rawType)) {
      errors.push({ field: `items[${i}].type`, message: `Type must be one of ${[...CLIENT_LIST_TYPES].join(', ')} (got "${rawType || '(empty)'}").`, code: 'INVALID_TYPE' })
    }

    if (!contractId) {
      errors.push({ field: `items[${i}].contractId`, message: 'Contract ID is required (needed to create the list).', code: 'EMPTY_CONTRACT' })
    }
    if (groupId == null) {
      errors.push({ field: `items[${i}].groupId`, message: 'Group ID is required and must be a positive integer.', code: 'INVALID_GROUP' })
    }

    if (tags.length > MAX_TAGS) {
      errors.push({ field: `items[${i}].tags`, message: `A client list may have at most ${MAX_TAGS} tags (got ${tags.length}).`, code: 'TOO_MANY_TAGS' })
    }
    tags.forEach((tag, j) => {
      if (tag.length > MAX_TAG_LENGTH) {
        errors.push({ field: `items[${i}].tags[${j}]`, message: `Tag must be ${MAX_TAG_LENGTH} characters or fewer.`, code: 'TAG_TOO_LONG' })
      }
    })

    if (values.length === 0) {
      warnings.push({ field: `items[${i}].items`, message: `List "${name || i}" has no entries — it will be created/updated empty.`, code: 'EMPTY_LIST' })
    }

    values.forEach((el, j) => {
      if (type === 'IP') {
        if (!isValidIpElement(el)) {
          errors.push({ field: `items[${i}].items[${j}]`, message: `IP entry "${el}" is not a valid IP address or CIDR block.`, code: 'INVALID_IP' })
        }
      } else if (type === 'GEO') {
        if (!GEO_RE.test(el)) {
          errors.push({ field: `items[${i}].items[${j}]`, message: `GEO entry "${el}" must be a two-letter country code (e.g. US).`, code: 'INVALID_GEO' })
        }
      } else if (type === 'ASN') {
        if (!ASN_RE.test(el)) {
          errors.push({ field: `items[${i}].items[${j}]`, message: `ASN entry "${el}" must be an AS number (e.g. 64512 or AS64512).`, code: 'INVALID_ASN' })
        }
      }
      // Other types (TLS_FINGERPRINT, FILE_HASH, USER_ID, DOMAIN,
      // REQUEST_HEADER_NAME_VALUE) have varied formats and are accepted as-is.
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
