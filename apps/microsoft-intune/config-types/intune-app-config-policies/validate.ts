import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  APP_GROUP_TYPES,
  PLATFORMS,
  hasAnyAssignment,
  normalizeAppGroupType,
  normalizePlatform,
  parseCustomSettings,
  readAssignmentSpec,
  readList,
  readString,
  type AppConfigSpec,
} from './appConfig'

/** The policy name (displayName) is the reconciliation key. */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item is one app configuration policy: custom settings + targeted apps + assignment. */
export function extractAppConfigSpecs(canvas: CanvasSnapshot): AppConfigSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const parsed = parseCustomSettings(fields.customSettings)
    return {
      sectionName: section.name,
      name: readString(fields.name),
      description: readString(fields.description),
      platform: normalizePlatform(fields.platform),
      appGroupType: normalizeAppGroupType(fields.appGroupType),
      targetedApps: readList(fields.targetedApps),
      customSettings: parsed.settings,
      customSettingsError: parsed.error,
      assignment: readAssignmentSpec(fields),
    }
  })
}

/**
 * Validate app configuration policies: each needs a unique name; the customSettings
 * input must parse to an array of { name, value } pairs; the platform and app group
 * must be known values; a selectedPublicApps policy needs at least one targeted app.
 * A policy with no assignment target, or targeted apps that will be ignored, warns.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no app configuration policy items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAppConfigSpecs(ctx.canvas)
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

    if (spec.customSettingsError) {
      errors.push({ field: `${prefix}.customSettings`, message: spec.customSettingsError, code: 'invalid_custom_settings' })
    }

    if (!(PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({ field: `${prefix}.platform`, message: `Platform must be one of: ${PLATFORMS.join(', ')}`, code: 'invalid_platform' })
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
        message: 'At least one targeted app (bundle id / package id) is required when the app group is "Selected apps"',
        code: 'targeted_apps_required',
      })
    }

    if (spec.appGroupType !== 'selectedPublicApps' && spec.targetedApps.length > 0) {
      warnings.push({
        field: `${prefix}.targetedApps`,
        message: 'Targeted app ids are only used with "Selected apps" and will be ignored',
        code: 'ignored_targeted_apps',
      })
    }

    if (spec.customSettings.length === 0 && !spec.customSettingsError) {
      warnings.push({
        field: `${prefix}.customSettings`,
        message: 'Policy has no custom settings — it will push no configuration to the targeted apps',
        code: 'no_custom_settings',
      })
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
