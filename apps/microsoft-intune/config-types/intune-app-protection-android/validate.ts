import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  MANAGED_FIELDS,
  hasAnyAssignment,
  readAppGroupType,
  readAssignmentSpec,
  readList,
  readManagedSettings,
  readStringSetting,
  type AndroidAppProtectionSpec,
} from './appProtection'

/** The policy name (displayName) is the reconciliation key. */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item is one Android app protection policy. */
export function extractProtectionSpecs(canvas: CanvasSnapshot): AndroidAppProtectionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readStringSetting(fields.name) ?? '',
      description: readStringSetting(fields.description) ?? '',
      settings: readManagedSettings(fields),
      appGroupType: readAppGroupType(fields.appGroupType),
      targetedApps: readList(fields.targetedApps),
      assignment: readAssignmentSpec(fields),
    }
  })
}

/**
 * Validate Android app protection policies: each needs a name (unique across the
 * canvas); a selectedPublicApps policy needs at least one targeted app package id;
 * every configured number stays within its range and every enum select carries a
 * known value. A policy with no assignment target, or targeted apps that will be
 * ignored, is warned (non-blocking).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no app protection policy items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProtectionSpecs(ctx.canvas)
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

    if (spec.appGroupType === 'selectedPublicApps' && spec.targetedApps.length === 0) {
      errors.push({
        field: `${prefix}.targetedApps`,
        message: 'At least one targeted app package ID is required when targeting selected public apps',
        code: 'no_targeted_apps',
      })
    }

    if (spec.appGroupType !== 'selectedPublicApps' && spec.targetedApps.length > 0) {
      warnings.push({
        field: `${prefix}.targetedApps`,
        message: 'Targeted app package IDs are only used with "Selected public apps" and will be ignored',
        code: 'ignored_targeted_apps',
      })
    }

    for (const f of MANAGED_FIELDS) {
      const value = spec.settings[f.key]
      if (value === undefined) continue
      if (f.kind === 'number' && typeof value === 'number') {
        if ((f.min !== undefined && value < f.min) || (f.max !== undefined && value > f.max)) {
          errors.push({
            field: `${prefix}.${f.key}`,
            message: `${f.label} must be between ${f.min} and ${f.max}`,
            code: 'out_of_range',
          })
        }
      } else if (f.kind === 'enum' && f.options && typeof value === 'string' && !f.options.includes(value)) {
        errors.push({
          field: `${prefix}.${f.key}`,
          message: `${f.label} "${value}" is not a valid value`,
          code: 'invalid_enum',
        })
      }
    }

    if (!hasAnyAssignment(spec.assignment)) {
      warnings.push({
        field: `${prefix}.assignment`,
        message: `Policy "${spec.name || prefix}" has no assignment target — it will be deployed but not assigned to any users`,
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
