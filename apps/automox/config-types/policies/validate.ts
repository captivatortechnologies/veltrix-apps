import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  extractPolicySpecs,
  policyKey,
  buildConfiguration,
  parseDeviceFilters,
  parseConfigurationJson,
  POLICY_TYPES,
  PATCH_RULES,
  FILTER_TYPES,
  SEVERITY_FILTERS,
  DAY_NAMES,
} from './_shared'

const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Validate Policy items: a non-empty, unique name (the logical identity), a
 * supported `policy_type_name`, a well-formed schedule, and — per policy
 * type — the fields the Automox API requires:
 *   - patch: patch_rule + filter_type/filters/severity_filter combination,
 *     and any device-filter JSON.
 *   - required_software / custom: a well-formed `configuration` JSON object
 *     (FLAGGED as a light passthrough — see README.md / CHANGELOG.md).
 * Static — no target access required.
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

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = policyKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Policy "${spec.name}" — each name may only be declared once per canvas.`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }

    if (!POLICY_TYPES.includes(spec.policyTypeName)) {
      errors.push({
        field: `${prefix}.policy_type_name`,
        message: `Unsupported policy type "${spec.policyTypeName}". Expected one of: ${POLICY_TYPES.join(', ')}.`,
        code: 'INVALID_POLICY_TYPE',
      })
    }

    // Schedule — schedule_days of 0 (no days selected) means "unscheduled";
    // schedule_time is still validated so a garbage value never reaches the API.
    if (!SCHEDULE_TIME_RE.test(spec.scheduleTime)) {
      errors.push({
        field: `${prefix}.schedule_time`,
        message: `Schedule Time "${spec.scheduleTime}" must be in 24-hour HH:MM format (e.g. "02:00").`,
        code: 'INVALID_SCHEDULE_TIME',
      })
    }
    for (const day of spec.scheduleDayNames) {
      if (!DAY_NAMES.includes(day.toLowerCase() as (typeof DAY_NAMES)[number])) {
        errors.push({
          field: `${prefix}.schedule_days`,
          message: `Unrecognized schedule day "${day}". Expected one of: ${DAY_NAMES.join(', ')}.`,
          code: 'INVALID_SCHEDULE_DAY',
        })
      }
    }
    if (spec.scheduleDays === 0) {
      warnings.push({
        field: `${prefix}.schedule_days`,
        message: `"${spec.name || 'policy'}" has no Schedule Days selected — it will deploy unscheduled and will not run automatically.`,
        code: 'UNSCHEDULED',
      })
    }
    if (spec.useScheduledTimezone && !spec.scheduledTimezone) {
      errors.push({
        field: `${prefix}.scheduled_timezone`,
        message: 'Scheduled Timezone is required when "Use Scheduled Timezone" is enabled.',
        code: 'REQUIRED',
      })
    }

    if (spec.serverGroupsRaw.length !== spec.serverGroups.length) {
      errors.push({
        field: `${prefix}.server_groups`,
        message: 'Server Group IDs must all be non-negative integers.',
        code: 'INVALID_SERVER_GROUPS',
      })
    }

    if (spec.policyTypeName === 'patch') {
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
        const built = buildConfiguration(spec)
        if (built.error) {
          errors.push({ field: `${prefix}.configuration`, message: built.error, code: 'INVALID_PATCH_CONFIGURATION' })
        }
      }
    } else {
      const parsed = parseConfigurationJson(spec.configurationRaw)
      if (parsed.error) {
        errors.push({ field: `${prefix}.configuration_json`, message: parsed.error, code: 'INVALID_CONFIGURATION' })
      } else if (Object.keys(parsed.value).length === 0) {
        warnings.push({
          field: `${prefix}.configuration_json`,
          message:
            `"${spec.name || 'policy'}" (${spec.policyTypeName}) declares no Configuration (JSON) — Automox ` +
            'requires policy-type-specific fields here (e.g. package_name/installation_code for Required ' +
            'Software, or a Worklet script for Custom). See the Setup Guide.',
          code: 'EMPTY_CONFIGURATION',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
