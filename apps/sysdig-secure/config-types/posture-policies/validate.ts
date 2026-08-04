import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isMalformedJsonArray, parseRequirementGroups, POLICY_TYPES } from './_shared'

/**
 * Validate posture-policy items: a non-empty unique name, a known type, and a
 * well-formed non-empty requirement-groups tree where every group,
 * requirement and control has a name. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one posture policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const p = (field: string) => `items[${i}].${field}`

    if (!name) {
      errors.push({ field: p('name'), message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: p('name'), message: `Policy name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!String(item.fields.description ?? '').trim()) {
      errors.push({ field: p('description'), message: 'Description is required.', code: 'EMPTY_DESCRIPTION' })
    }

    const type = String(item.fields.type ?? 'aws').trim()
    if (!POLICY_TYPES.has(type)) {
      errors.push({ field: p('type'), message: `Type must be one of ${[...POLICY_TYPES].join(', ')} (got "${type}").`, code: 'INVALID_TYPE' })
    }

    if (isMalformedJsonArray(item.fields.requirementGroupsJson)) {
      errors.push({ field: p('requirementGroupsJson'), message: 'Requirement Groups must be valid JSON: an array of groups.', code: 'INVALID_GROUPS_JSON' })
      return
    }

    const groups = parseRequirementGroups(item.fields.requirementGroupsJson)
    if (groups.length === 0) {
      errors.push({ field: p('requirementGroupsJson'), message: 'At least one requirement group is required.', code: 'EMPTY_GROUPS' })
    }
    groups.forEach((group, gi) => {
      if (!group.name) errors.push({ field: p(`requirementGroupsJson[${gi}].name`), message: 'Each requirement group needs a name.', code: 'EMPTY_GROUP_NAME' })
      ;(group.requirements ?? []).forEach((req, ri) => {
        if (!req.name) errors.push({ field: p(`requirementGroupsJson[${gi}].requirements[${ri}].name`), message: 'Each requirement needs a name.', code: 'EMPTY_REQUIREMENT_NAME' })
        ;(req.controls ?? []).forEach((control, ci) => {
          if (!control.name) {
            errors.push({
              field: p(`requirementGroupsJson[${gi}].requirements[${ri}].controls[${ci}].name`),
              message: 'Each control needs a name.',
              code: 'EMPTY_CONTROL_NAME',
            })
          }
        })
      })
    })

    if (isMalformedJsonArray(item.fields.targetsJson)) {
      errors.push({ field: p('targetsJson'), message: 'Version Targets must be valid JSON: an array of {platform, minVersion, maxVersion}.', code: 'INVALID_TARGETS_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
