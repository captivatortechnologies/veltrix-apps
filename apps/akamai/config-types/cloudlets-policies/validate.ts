import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CLOUDLET_TYPES, parseMatchRules } from './_shared'

const NAME_RE = /^[a-zA-Z0-9_]+$/

/**
 * Validate Cloudlets Policy items: a non-empty name matching Akamai's
 * `^[a-zA-Z0-9_]+$` format (≤255 chars), a known cloudlet type, a positive
 * group id and well-formed `matchRules` JSON (an array). Static — no target
 * access required; the nested per-type rule SHAPE is not enforced here (see
 * canvas.yaml — Cloudlets itself validates it at deploy time). The name is
 * the identity, so a duplicate is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Cloudlets policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const cloudletType = String(item.fields.cloudletType ?? '').trim().toUpperCase()
    const groupId = item.fields.groupId

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 255) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name must be 255 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else if (!NAME_RE.test(name)) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name may only contain letters, digits and underscores.', code: 'INVALID_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Policy name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!CLOUDLET_TYPES.has(cloudletType)) {
      errors.push({ field: `items[${i}].cloudletType`, message: `Cloudlet Type must be one of AP, AS, CD, ER, FR, IG (got "${cloudletType || '(empty)'}").`, code: 'INVALID_CLOUDLET_TYPE' })
    }

    if (typeof groupId !== 'number' || !Number.isFinite(groupId) || groupId < 1) {
      errors.push({ field: `items[${i}].groupId`, message: 'Group ID must be a positive number.', code: 'INVALID_GROUP_ID' })
    }

    try {
      const rules = parseMatchRules(item.fields.matchRules)
      if (rules.length === 0) {
        warnings.push({ field: `items[${i}].matchRules`, message: `Policy "${name || i}" has no match rules — it will match nothing.`, code: 'EMPTY_MATCH_RULES' })
      }
    } catch (error) {
      errors.push({ field: `items[${i}].matchRules`, message: error instanceof Error ? error.message : 'Invalid match rules.', code: 'INVALID_MATCH_RULES_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
