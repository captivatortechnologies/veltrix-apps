// Generic validation helpers shared by every Automox config type.

import type { ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { DAY_NAMES, policyKey, type PolicyCommonFields } from './automoxPolicies'

const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Validate an item's name identity: required, and unique (case-insensitive)
 * within the `seen` set the caller threads across every item in the canvas.
 */
export function validateUniqueName(
  name: string,
  prefix: string,
  seen: Set<string>,
  errors: ValidationError[],
  opts: { label?: string; emptyCode?: string; duplicateCode?: string } = {},
): void {
  const label = opts.label ?? 'Name'
  if (!name) {
    errors.push({ field: `${prefix}.name`, message: `${label} is required.`, code: opts.emptyCode ?? 'EMPTY_NAME' })
    return
  }
  const key = policyKey(name)
  if (seen.has(key)) {
    errors.push({
      field: `${prefix}.name`,
      message: `Duplicate ${label.toLowerCase()} "${name}" — each name may only be declared once per canvas.`,
      code: opts.duplicateCode ?? 'DUPLICATE_NAME',
    })
  }
  seen.add(key)
}

/**
 * Validate the fields common to every `/policies` object (patch, custom,
 * required_software): schedule (days/time/timezone) and Server Group ids.
 * Shared by the `policies` and `worklets` config types.
 */
export function validatePolicyCommonFields(
  spec: PolicyCommonFields,
  prefix: string,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  // schedule_days of 0 (no days selected) means "unscheduled"; schedule_time
  // is still validated so a garbage value never reaches the API.
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
      message: `"${spec.name || 'item'}" has no Schedule Days selected — it will deploy unscheduled and will not run automatically.`,
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
}
