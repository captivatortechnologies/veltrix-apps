import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'
import type { LiveFileVantageEntity } from '../../lib/filevantageAdapter'

// --- FileVantage Scheduled Exclusion API constraints -------------------------

/**
 * Recurrence choices on the canvas. "never" is a one-time window (no `repeated`
 * object sent); the other three map straight to the API's `repeated.frequency`.
 */
export const RECURRENCE_OPTIONS = ['never', 'daily', 'weekly', 'monthly'] as const
export type Recurrence = (typeof RECURRENCE_OPTIONS)[number]

/** Weekday names accepted for `repeated.weekly_days` (normalized lowercase). */
export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const

/** The `processes`/`users` scope strings are limited to 500 characters by the API. */
export const SCOPE_MAX_LENGTH = 500

/** RFC3339 timestamp (schedule_start / schedule_end), with Z or a numeric offset. */
export const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
/** 24-hour HH:MM recurrence time. */
export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

// --- Live shape returned by the scheduled-exclusions entity endpoint ----------

/**
 * A scheduled exclusion as returned by
 * GET /filevantage/entities/policy-scheduled-exclusions/v1. Extends the shared
 * FileVantage entity (id/name/description/modified_by/modified_timestamp) with
 * the schedule-specific fields; `processes`/`users` come back as comma-delimited
 * strings, the same shape they are written in.
 */
export interface LiveScheduledExclusion extends LiveFileVantageEntity {
  policy_id?: string
  schedule_start?: string
  schedule_end?: string
  timezone?: string
  processes?: string
  users?: string
  repeated?: {
    frequency?: string
    all_day?: boolean
    start_time?: string
    end_time?: string
    weekly_days?: string[]
    monthly_days?: number[]
    occurrence?: string
  } | null
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ScheduledExclusionSpec {
  sectionName: string
  name: string
  description?: string
  policyId: string
  timezone: string
  scheduleStart: string
  scheduleEnd?: string
  recurrence: Recurrence
  allDay: boolean
  startTime?: string
  endTime?: string
  weeklyDays: string[]
  monthlyDays: string[]
  processes: string[]
  users: string[]
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const asRecurrence = (value: unknown): Recurrence => {
  const v = asString(value).toLowerCase()
  return (RECURRENCE_OPTIONS as readonly string[]).includes(v) ? (v as Recurrence) : 'never'
}

/** Each canvas section describes one scheduled exclusion. */
export function extractScheduledExclusionSpecs(canvas: CanvasSnapshot): ScheduledExclusionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description = asString(fields.description)
    const scheduleEnd = asString(fields.scheduleEnd)
    const startTime = asString(fields.startTime)
    const endTime = asString(fields.endTime)
    return {
      sectionName: section.name,
      name: asString(fields.name),
      description: description.length > 0 ? description : undefined,
      policyId: asString(fields.policyId),
      timezone: asString(fields.timezone) || 'UTC',
      scheduleStart: asString(fields.scheduleStart),
      scheduleEnd: scheduleEnd.length > 0 ? scheduleEnd : undefined,
      recurrence: asRecurrence(fields.recurrence),
      // Falcon's default is an all-day recurrence; default true so an unset box
      // does not silently produce a zero-length daily window.
      allDay: coerceBoolean(fields.allDay, true),
      startTime: startTime.length > 0 ? startTime : undefined,
      endTime: endTime.length > 0 ? endTime : undefined,
      weeklyDays: splitList(fields.weeklyDays).map((d) => d.toLowerCase()),
      monthlyDays: splitList(fields.monthlyDays),
      processes: splitList(fields.processes),
      users: splitList(fields.users),
    }
  })
}

/** The comma-delimited scope string the API expects for processes/users. */
export function scopeString(values: string[]): string {
  return values.join(',')
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scheduled-exclusion configurations against the FileVantage
 * Scheduled Exclusions API: identity (name + policy), a well-formed RFC3339
 * schedule window (end after start), a recognized recurrence with its required
 * day set, a valid recurring time window, and at least one process/user scope
 * value within the 500-character limit.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScheduledExclusionSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity within a policy)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Exclusion name is required', code: 'required' })
    } else if (spec.name.length > 255) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Exclusion name must be 255 characters or fewer',
        code: 'too_long',
      })
    }

    // policy id
    if (!spec.policyId) {
      errors.push({
        field: `${prefix}.policyId`,
        message: 'FileVantage policy ID is required — a scheduled exclusion is bound to a policy',
        code: 'required',
      })
    }

    // duplicate name within the same policy
    if (spec.name && spec.policyId) {
      const key = `${spec.policyId}::${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate exclusion "${spec.name}" in policy ${spec.policyId} — each name may only be declared once per policy`,
          code: 'duplicate_exclusion',
        })
      }
      seen.add(key)
    }

    // timezone
    if (!spec.timezone) {
      errors.push({ field: `${prefix}.timezone`, message: 'Timezone is required', code: 'required' })
    }

    // schedule window
    if (!spec.scheduleStart) {
      errors.push({
        field: `${prefix}.scheduleStart`,
        message: 'Schedule start is required',
        code: 'required',
      })
    } else if (!RFC3339_RE.test(spec.scheduleStart)) {
      errors.push({
        field: `${prefix}.scheduleStart`,
        message: 'Schedule start must be an RFC3339 timestamp, e.g. 2026-08-01T00:00:00Z',
        code: 'invalid_format',
      })
    }

    if (spec.scheduleEnd !== undefined) {
      if (!RFC3339_RE.test(spec.scheduleEnd)) {
        errors.push({
          field: `${prefix}.scheduleEnd`,
          message: 'Schedule end must be an RFC3339 timestamp, e.g. 2026-08-08T00:00:00Z',
          code: 'invalid_format',
        })
      } else if (
        RFC3339_RE.test(spec.scheduleStart) &&
        Date.parse(spec.scheduleEnd) <= Date.parse(spec.scheduleStart)
      ) {
        errors.push({
          field: `${prefix}.scheduleEnd`,
          message: 'Schedule end must be after the schedule start',
          code: 'end_before_start',
        })
      }
    }

    // recurrence + its required day set / time window
    validateRecurrence(spec, prefix, errors)

    // scope: at least one process or user, each within the 500-char API limit
    if (spec.processes.length === 0 && spec.users.length === 0) {
      errors.push({
        field: `${prefix}.processes`,
        message: 'At least one process or user must be excluded',
        code: 'empty_scope',
      })
    }
    if (scopeString(spec.processes).length > SCOPE_MAX_LENGTH) {
      errors.push({
        field: `${prefix}.processes`,
        message: `Processes list exceeds the ${SCOPE_MAX_LENGTH}-character API limit`,
        code: 'too_long',
      })
    }
    if (scopeString(spec.users).length > SCOPE_MAX_LENGTH) {
      errors.push({
        field: `${prefix}.users`,
        message: `Users list exceeds the ${SCOPE_MAX_LENGTH}-character API limit`,
        code: 'too_long',
      })
    }

    // broad-exclusion warnings
    if (spec.processes.some(isWildcard) || spec.users.some(isWildcard)) {
      warnings.push({
        field: `${prefix}.processes`,
        message: 'A wildcard ("*") scope suppresses monitoring very broadly — confirm this is intended',
        code: 'broad_scope',
      })
    }
    if (spec.recurrence !== 'never' && spec.allDay && spec.scheduleEnd === undefined) {
      warnings.push({
        field: `${prefix}.scheduleEnd`,
        message:
          'An all-day recurring exclusion with no end date suppresses monitoring indefinitely — set a schedule end to bound it',
        code: 'unbounded_exclusion',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

function validateRecurrence(
  spec: ScheduledExclusionSpec,
  prefix: string,
  errors: ValidationResult['errors'],
): void {
  if (!(RECURRENCE_OPTIONS as readonly string[]).includes(spec.recurrence)) {
    errors.push({
      field: `${prefix}.recurrence`,
      message: `Recurrence must be one of: ${RECURRENCE_OPTIONS.join(', ')}`,
      code: 'invalid_recurrence',
    })
    return
  }
  if (spec.recurrence === 'never') return

  // recurring, not all-day → a valid HH:MM window with end after start
  if (!spec.allDay) {
    for (const [key, value] of [
      ['startTime', spec.startTime],
      ['endTime', spec.endTime],
    ] as const) {
      if (!value) {
        errors.push({
          field: `${prefix}.${key}`,
          message: 'A start and end time are required for a recurring exclusion that is not all-day',
          code: 'required',
        })
      } else if (!HHMM_RE.test(value)) {
        errors.push({
          field: `${prefix}.${key}`,
          message: 'Time must be a 24-hour HH:MM value, e.g. 22:00',
          code: 'invalid_format',
        })
      }
    }
    if (
      spec.startTime &&
      spec.endTime &&
      HHMM_RE.test(spec.startTime) &&
      HHMM_RE.test(spec.endTime) &&
      spec.endTime <= spec.startTime
    ) {
      errors.push({
        field: `${prefix}.endTime`,
        message: 'Recurrence end time must be after the start time',
        code: 'end_before_start',
      })
    }
  }

  if (spec.recurrence === 'weekly') {
    if (spec.weeklyDays.length === 0) {
      errors.push({
        field: `${prefix}.weeklyDays`,
        message: `At least one weekday is required for a weekly exclusion: ${WEEKDAYS.join(', ')}`,
        code: 'required',
      })
    } else {
      for (const day of spec.weeklyDays) {
        if (!(WEEKDAYS as readonly string[]).includes(day)) {
          errors.push({
            field: `${prefix}.weeklyDays`,
            message: `Unknown weekday "${day}" — allowed: ${WEEKDAYS.join(', ')}`,
            code: 'invalid_weekday',
          })
        }
      }
    }
  }

  if (spec.recurrence === 'monthly') {
    if (spec.monthlyDays.length === 0) {
      errors.push({
        field: `${prefix}.monthlyDays`,
        message: 'At least one day of the month (1–31) is required for a monthly exclusion',
        code: 'required',
      })
    } else {
      for (const day of spec.monthlyDays) {
        const n = Number(day)
        if (!Number.isInteger(n) || n < 1 || n > 31) {
          errors.push({
            field: `${prefix}.monthlyDays`,
            message: `Invalid day of month "${day}" — must be an integer from 1 to 31`,
            code: 'invalid_monthly_day',
          })
        }
      }
    }
  }
}

/** A scope entry that matches broadly enough to warrant a warning. */
function isWildcard(value: string): boolean {
  return value.trim() === '*' || value.trim() === '**'
}
