import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { KEY_TYPES, REPUTATIONS, isValidKey, normalizeBool, normalizeKey } from './_shared'

/**
 * Validate custom-reputation items: a known key type, a non-empty key whose
 * shape matches its type, and a known reputation verdict. Static — no target
 * access required. The key is the reputation's identity, so a duplicate key is
 * flagged (last one wins). `preventExecution` is only meaningful on a
 * blocklisted file hash — anything else is warned (it is dropped at deploy time).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom reputation.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const keyType = String(item.fields.keyType ?? '').trim()
    const key = String(item.fields.key ?? '').trim()
    const reputation = String(item.fields.reputation ?? '').trim()

    if (!KEY_TYPES.has(keyType)) {
      errors.push({
        field: `items[${i}].keyType`,
        message: `Key type must be one of file, domain, ipv4 (got "${keyType}").`,
        code: 'INVALID_KEY_TYPE',
      })
    }

    if (!key) {
      errors.push({ field: `items[${i}].key`, message: 'Key is required.', code: 'EMPTY_KEY' })
    } else if (KEY_TYPES.has(keyType) && !isValidKey(keyType, key)) {
      errors.push({
        field: `items[${i}].key`,
        message:
          keyType === 'file'
            ? `Key "${key}" must be an MD5 (32) or SHA-1 (40) hex hash.`
            : `Key "${key}" is not a valid ${keyType} value.`,
        code: 'INVALID_KEY',
      })
    } else if (KEY_TYPES.has(keyType)) {
      const id = `${keyType}:${normalizeKey(keyType, key)}`
      if (seen.has(id)) {
        warnings.push({ field: `items[${i}].key`, message: `Key ${key} is listed more than once; the last one wins.`, code: 'DUPLICATE_KEY' })
      } else {
        seen.add(id)
      }
    }

    if (!REPUTATIONS.has(reputation)) {
      errors.push({
        field: `items[${i}].reputation`,
        message: `Reputation must be one of whitelist, blacklist (got "${reputation}").`,
        code: 'INVALID_REPUTATION',
      })
    }

    if (normalizeBool(item.fields.preventExecution) && !(keyType === 'file' && reputation === 'blacklist')) {
      warnings.push({
        field: `items[${i}].preventExecution`,
        message: 'Prevent execution only applies to a blocklisted file hash — it will be ignored for this item.',
        code: 'PREVENT_IGNORED',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
