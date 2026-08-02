import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseDeviceFilters } from '../lib/automoxPolicies'
import { validateUniqueName, validatePolicyCommonFields } from '../lib/validation'
import { extractWorkletSpecs, buildConfiguration, WORKLET_TYPES } from './_shared'

/**
 * Validate Worklet items: a non-empty, unique name (scoped to this canvas), a
 * supported `worklet_type`, a well-formed schedule, and the type-specific
 * fields the Automox API requires — Evaluation Code for a Custom (Worklet)
 * policy; Package Name / Package Version / Installation Code for a Required
 * Software policy. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractWorkletSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Worklet.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    validateUniqueName(spec.name, prefix, seen, errors, { label: 'Worklet name' })
    validatePolicyCommonFields(spec, prefix, errors, warnings)

    if (!WORKLET_TYPES.includes(spec.workletType)) {
      errors.push({
        field: `${prefix}.worklet_type`,
        message: `Unsupported Type "${spec.workletType}". Expected one of: ${WORKLET_TYPES.join(', ')}.`,
        code: 'INVALID_WORKLET_TYPE',
      })
    }

    const deviceFilters = parseDeviceFilters(spec.deviceFiltersRaw)
    if (deviceFilters.error) {
      errors.push({ field: `${prefix}.device_filters_json`, message: deviceFilters.error, code: 'INVALID_DEVICE_FILTERS' })
    }

    // Structural check reusing the same builder deploy uses — catches the
    // per-type "required fields" requirements without duplicating that logic
    // here (Evaluation Code for Custom; Package Name/Version/Installation
    // Code for Required Software).
    if (!deviceFilters.error) {
      const built = buildConfiguration(spec)
      if (built.error) {
        const field = spec.workletType === 'custom' ? 'evaluation_code' : 'package_name'
        errors.push({ field: `${prefix}.${field}`, message: built.error, code: 'INVALID_WORKLET_CONFIGURATION' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
