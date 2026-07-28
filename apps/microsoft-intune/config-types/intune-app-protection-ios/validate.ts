import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  APP_GROUP_TYPES,
  MAM_FIELDS,
  hasAnyAssignment,
  normalizeAppGroupType,
  readAssignmentSpec,
  readList,
  readManagedFields,
  type IosMamPolicySpec,
} from './iosAppProtection'

/** The policy name (displayName) is the reconciliation key. */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item is one iOS MAM policy: scalars + targeted apps + assignment. */
export function extractIosMamSpecs(canvas: CanvasSnapshot): IosMamPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      graph: readManagedFields(fields),
      appGroupType: normalizeAppGroupType(fields.appGroupType),
      targetedApps: readList(fields.targetedApps),
      assignment: readAssignmentSpec(fields),
    }
  })
}

/**
 * Validate iOS app protection policies: each needs a unique name, every managed
 * number field within its range and enum selects a known value. When the app
 * group is selectedPublicApps at least one targeted app is required (otherwise the
 * policy would protect nothing). A policy with no assignment target warns.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no app protection policy items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIosMamSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      const key = policyKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate policy name "${spec.name}"`, code: 'duplicate_policy' })
      }
      seen.add(key)
    }

    if (!(APP_GROUP_TYPES as readonly string[]).includes(spec.appGroupType)) {
      errors.push({
        field: `${prefix}.appGroupType`,
        message: `App group type must be one of: ${APP_GROUP_TYPES.join(', ')}`,
        code: 'invalid_app_group_type',
      })
    }

    if (spec.appGroupType === 'selectedPublicApps' && spec.targetedApps.length === 0) {
      errors.push({
        field: `${prefix}.targetedApps`,
        message: 'At least one targeted app (bundle id) is required when the app group is "Selected apps"',
        code: 'targeted_apps_required',
      })
    }

    for (const def of MAM_FIELDS) {
      if (!(def.key in spec.graph)) continue
      const value = spec.graph[def.key]
      if (def.type === 'number' && typeof value === 'number') {
        if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) {
          const bound = def.max !== undefined ? `between ${def.min} and ${def.max}` : `${def.min} or greater`
          errors.push({ field: `${prefix}.${def.key}`, message: `${def.label} must be ${bound}`, code: 'out_of_range' })
        }
      } else if (def.type === 'enum' && def.options && typeof value === 'string' && !def.options.includes(value)) {
        errors.push({ field: `${prefix}.${def.key}`, message: `${def.label} "${value}" is not a valid value`, code: 'invalid_enum' })
      }
    }

    if (!hasAnyAssignment(spec.assignment)) {
      warnings.push({
        field: `${prefix}.includeGroups`,
        message: 'Policy has no assignment — add include groups or target all users, or it will apply to nobody',
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
