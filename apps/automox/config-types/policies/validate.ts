import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseDeviceFilters } from '../lib/automoxPolicies'
import { validateUniqueName, validatePolicyCommonFields } from '../lib/validation'
import { extractPolicySpecs, buildPatchConfiguration, PATCH_RULES, FILTER_TYPES, SEVERITY_FILTERS } from './_shared'

/**
 * Validate Policy items: a non-empty, unique name (the logical identity), a
 * well-formed schedule, and the patch-specific fields the Automox API
 * requires — patch_rule + filter_type/filters/severity_filter combination,
 * and any device-filter JSON. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    validateUniqueName(spec.name, prefix, seen, errors, { label: 'Policy name' })
    validatePolicyCommonFields(spec, prefix, errors, warnings)

    if (!PATCH_RULES.includes(spec.patchRule as (typeof PATCH_RULES)[number])) {
      errors.push({
        field: `${prefix}.patch_rule`,
        message: `Unsupported Patch Rule "${spec.patchRule}". Expected one of: ${PATCH_RULES.join(', ')}.`,
        code: 'INVALID_PATCH_RULE',
      })
    }
    if (spec.patchRule === 'filter') {
      if (!FILTER_TYPES.includes(spec.filterType as (typeof FILTER_TYPES)[number])) {
        errors.push({
          field: `${prefix}.filter_type`,
          message: `Unsupported Filter Type "${spec.filterType}". Expected one of: ${FILTER_TYPES.join(', ')}.`,
          code: 'INVALID_FILTER_TYPE',
        })
      } else if (spec.filterType === 'severity') {
        for (const sev of spec.severityFilter) {
          if (!SEVERITY_FILTERS.includes(sev as (typeof SEVERITY_FILTERS)[number])) {
            errors.push({
              field: `${prefix}.severity_filter`,
              message: `Unsupported severity "${sev}". Expected one of: ${SEVERITY_FILTERS.join(', ')}.`,
              code: 'INVALID_SEVERITY',
            })
          }
        }
      }
    }

    const deviceFilters = parseDeviceFilters(spec.deviceFiltersRaw)
    if (deviceFilters.error) {
      errors.push({ field: `${prefix}.device_filters_json`, message: deviceFilters.error, code: 'INVALID_DEVICE_FILTERS' })
    }

    // Structural check reusing the same builder deploy uses — catches the
    // filter/severity "at least one value" requirements without duplicating
    // that logic here.
    if (!deviceFilters.error) {
      const built = buildPatchConfiguration(spec)
      if (built.error) {
        errors.push({ field: `${prefix}.configuration`, message: built.error, code: 'INVALID_PATCH_CONFIGURATION' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
