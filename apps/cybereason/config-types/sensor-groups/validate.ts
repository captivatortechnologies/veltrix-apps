import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isGuid, isValidJson } from './_shared'

/**
 * Validate sensor-group items: a non-empty name (the upsert identity, so a
 * duplicate is flagged — last one wins), an optional policyId that should be a
 * GUID, and — when provided — a valid-JSON groupAssignRule. Static; no target
 * access. FLAGGED: the groupAssignRule inner schema is unverified — only its JSON
 * validity is checked here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sensor group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const policyId = String(item.fields.policyId ?? '').trim()
    const rule = String(item.fields.groupAssignRule ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Group ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (policyId && !isGuid(policyId)) {
      warnings.push({
        field: `items[${i}].policyId`,
        message: `Policy id "${policyId}" does not look like a GUID — verify it against your Cybereason tenant.`,
        code: 'POLICY_ID_SHAPE',
      })
    }

    if (rule && !isValidJson(rule)) {
      errors.push({ field: `items[${i}].groupAssignRule`, message: 'Group assignment rule must be valid JSON.', code: 'INVALID_ASSIGN_RULE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
