import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { YES_NO, PERM_FIELDS } from './_shared'

const YES_NO_FIELDS = [...PERM_FIELDS, 'default_role', 'restricted_to_site_admin', 'enforce_rate_limit'] as const

/**
 * Validate role items: a non-empty name and every permission/state field set to
 * a known yes/no value. Static — no target access required. The name doubles as
 * the role identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one role.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Role name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    for (const key of YES_NO_FIELDS) {
      const value = String(item.fields[key] ?? '').trim()
      if (!YES_NO.has(value)) {
        errors.push({ field: `items[${i}].${key}`, message: `${key} must be yes or no (got "${value}").`, code: 'INVALID_YES_NO' })
      }
    }

    const rateLimitCount = item.fields.rate_limit_count
    if (rateLimitCount !== undefined && rateLimitCount !== '' && (!Number.isFinite(Number(rateLimitCount)) || Number(rateLimitCount) < 0)) {
      errors.push({ field: `items[${i}].rate_limit_count`, message: 'Rate Limit Count must be a non-negative number.', code: 'INVALID_NUMBER' })
    }

    const memoryLimit = String(item.fields.memory_limit ?? '').trim()
    if (memoryLimit && memoryLimit !== '-1' && !/^[0-9]+[MG]$/i.test(memoryLimit)) {
      errors.push({ field: `items[${i}].memory_limit`, message: 'Memory Limit must look like 512M or 1G, or -1 for unlimited.', code: 'INVALID_MEMORY_LIMIT' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
