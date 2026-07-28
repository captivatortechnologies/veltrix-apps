import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  COMPLIANCE_FIELDS,
  PLATFORMS,
  normalizePlatform,
  readAssignmentSpec,
  readComplianceSettings,
  readNonComplianceAction,
  readNumberSetting,
  readStringSetting,
  type CompliancePlatform,
  type CompliancePolicySpec,
} from './compliance'

/** The policy name (displayName) is the reconciliation key. */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item is one compliance policy: a platform + settings + actions + assignment. */
export function extractComplianceSpecs(canvas: CanvasSnapshot): CompliancePolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readStringSetting(fields.policy_name) ?? '',
      platform: normalizePlatform(fields.platform),
      description: readStringSetting(fields.description) ?? '',
      settings: readComplianceSettings(fields),
      gracePeriodHours: readNumberSetting(fields.grace_period_hours) ?? 0,
      nonComplianceAction: readNonComplianceAction(fields.non_compliance_action),
      assignment: readAssignmentSpec(fields),
    }
  })
}

/** Settings the user configured that do not apply to the chosen platform (ignored on deploy). */
function ignoredSettingsForPlatform(spec: CompliancePolicySpec, platform: CompliancePlatform): string[] {
  return COMPLIANCE_FIELDS.filter((f) => spec.settings[f.key] !== undefined && f.graphProp(platform) === null).map((f) => f.key)
}

/**
 * Validate device compliance policies: each needs a name (unique across the canvas),
 * a supported platform, and a non-negative grace period. Settings that do not apply
 * to the chosen platform and policies with no assignment target warn (non-blocking).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no compliance policy items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractComplianceSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.policy_name`, message: 'Policy name is required', code: 'required' })
    } else {
      const key = policyKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.policy_name`, message: `Duplicate policy name "${spec.name}"`, code: 'duplicate_policy' })
      }
      seen.add(key)
    }

    if (!spec.platform) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform is required and must be one of: ${Object.keys(PLATFORMS).join(', ')}`,
        code: 'invalid_platform',
      })
    }

    if (spec.gracePeriodHours < 0 || !Number.isFinite(spec.gracePeriodHours)) {
      errors.push({ field: `${prefix}.grace_period_hours`, message: 'Grace period (hours) must be zero or greater', code: 'invalid_grace_period' })
    }

    if (spec.platform) {
      const ignored = ignoredSettingsForPlatform(spec, spec.platform)
      if (ignored.length > 0) {
        warnings.push({
          field: `${prefix}.settings`,
          message: `These settings do not apply to ${PLATFORMS[spec.platform].label} and will be ignored: ${ignored.join(', ')}`,
          code: 'ignored_setting',
        })
      }
    }

    const a = spec.assignment
    if (a.includeGroupIds.length === 0 && a.excludeGroupIds.length === 0 && !a.allDevices && !a.allUsers) {
      warnings.push({
        field: `${prefix}.assignment`,
        message: `Policy "${spec.name || prefix}" has no assignment target — it will be deployed but not assigned to any devices or users`,
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
