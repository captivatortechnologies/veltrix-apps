import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractEnforcerGroupSpecs } from './_shared'

const GROUP_ID_RE = /^[A-Za-z0-9_-]+$/

/**
 * Validate enforcer-group items: a non-empty unique group id (letters,
 * digits, - and _ only), a non-empty enforcer/orchestrator type, and — when
 * admission control is enabled — that Enforce Mode is also on (Aqua requires
 * this combination for admission control to actually block anything).
 * Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractEnforcerGroupSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one enforcer group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    if (!spec.groupId) {
      errors.push({ field: `items[${i}].groupId`, message: 'Group ID is required.', code: 'EMPTY_GROUP_ID' })
    } else if (!GROUP_ID_RE.test(spec.groupId)) {
      errors.push({ field: `items[${i}].groupId`, message: `Group ID "${spec.groupId}" may only contain letters, digits, - and _.`, code: 'INVALID_GROUP_ID' })
    } else if (spec.groupId.length > 128) {
      errors.push({ field: `items[${i}].groupId`, message: 'Group ID must be 128 characters or fewer.', code: 'GROUP_ID_TOO_LONG' })
    } else if (seen.has(spec.groupId)) {
      warnings.push({ field: `items[${i}].groupId`, message: `Group ID "${spec.groupId}" is listed more than once; the last one wins.`, code: 'DUPLICATE_GROUP_ID' })
    } else {
      seen.add(spec.groupId)
    }

    if (!spec.type) {
      errors.push({ field: `items[${i}].type`, message: 'Enforcer type is required.', code: 'EMPTY_TYPE' })
    }
    if (!spec.orchestratorType) {
      errors.push({ field: `items[${i}].orchestratorType`, message: 'Orchestrator type is required.', code: 'EMPTY_ORCHESTRATOR_TYPE' })
    }

    if (spec.admissionControl && !spec.enforce) {
      warnings.push({
        field: `items[${i}].admissionControl`,
        message: 'Admission control is enabled but Enforce Mode is off — Aqua only blocks admission when the group also enforces.',
        code: 'ADMISSION_WITHOUT_ENFORCE',
      })
    }

    for (const [field, values, min, max] of [
      ['scheduleScanDays', spec.scheduleScanDays, 0, 6],
      ['scheduleScanTime', spec.scheduleScanTime, 0, 23],
    ] as const) {
      for (const v of values) {
        if (v < min || v > max) {
          errors.push({ field: `items[${i}].${field}`, message: `${field} value ${v} must be between ${min} and ${max}.`, code: 'INVALID_SCHEDULE_VALUE' })
          break
        }
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
