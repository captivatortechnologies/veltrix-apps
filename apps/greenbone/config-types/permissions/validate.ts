import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_RE } from '../../lib/greenboneApi'
import { PERMISSION_SUBJECT_TYPES } from '../../lib/gmp/permissions'
import { extractSpecs } from './_shared'

/**
 * Validate permission items: a non-empty command name, a recognised subject
 * type, a UUID-shaped subject id, and (if a resource is declared) a
 * UUID-shaped resource id plus a resource type. Static — no gvmd access
 * required. Permissions have no name-based identity (see _shared.ts), so
 * there is no duplicate-name check here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one permission.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  extractSpecs(items).forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'A command name is required (e.g. "get_tasks", or "Super").', code: 'EMPTY_NAME' })
    }

    if (!(PERMISSION_SUBJECT_TYPES as readonly string[]).includes(spec.subjectType)) {
      errors.push({ field: `${prefix}.subjectType`, message: `Subject type must be one of: ${PERMISSION_SUBJECT_TYPES.join(', ')}.`, code: 'INVALID_SUBJECT_TYPE' })
    }

    if (!spec.subjectId) {
      errors.push({ field: `${prefix}.subjectId`, message: 'A subject UUID is required.', code: 'EMPTY_SUBJECT' })
    } else if (!UUID_RE.test(spec.subjectId)) {
      errors.push({ field: `${prefix}.subjectId`, message: `Subject "${spec.subjectId}" must be a GMP user/group/role UUID.`, code: 'INVALID_SUBJECT' })
    }

    if (spec.resourceId) {
      if (!UUID_RE.test(spec.resourceId)) {
        errors.push({ field: `${prefix}.resourceId`, message: `Resource "${spec.resourceId}" must be a GMP resource UUID.`, code: 'INVALID_RESOURCE' })
      }
      if (!spec.resourceType) {
        errors.push({ field: `${prefix}.resourceType`, message: 'A resource type is required when a resource UUID is declared.', code: 'EMPTY_RESOURCE_TYPE' })
      }
    } else if (spec.resourceType) {
      warnings.push({ field: `${prefix}.resourceId`, message: 'A resource type was declared without a resource UUID — this permission will be created as a global/command-level grant.', code: 'RESOURCE_TYPE_WITHOUT_ID' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
