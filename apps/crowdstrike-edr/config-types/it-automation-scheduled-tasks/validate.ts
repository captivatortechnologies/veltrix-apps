import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- Falcon for IT — IT Automation Scheduled Task API constraints -------------
//
// Verified against FalconPy `it_automation` (_endpoint + _payload/_it_automation).
// Scheduled-task entity: /it-automation/entities/scheduled-tasks/v1
// (GET/POST/PATCH/DELETE); query: /it-automation/queries/scheduled-tasks/v1
// (filterable on task_id, task_name, is_active, group_ids, group_names, ...).
// FalconPy's scheduled_task_payload assembles: task_id, is_active, schedule{...},
// target, execution_args, guardrails, distribute, discover_new_hosts,
// discover_offline_hosts, expiration_interval, trigger_condition.
// The schedule object uses: frequency, interval, time, timezone, start_time,
// end_time, days_of_week, day_of_month.
//
// A scheduled task has NO `name` of its own — its API identity is `task_id`
// (the canvas `name` is a Veltrix-side label). We manage ONE scheduled task per
// task_id.
//
// VERIFIED keys we push: task_id, is_active, schedule.
// UNVERIFIED / NOT pushed (this collection is newer/stabilizing): how host
// groups map onto the opaque `target` field. Per the defensive contract, host
// groups are captured + validated but NOT written — a targetless create that the
// live API rejects surfaces as a clean deploy error rather than a mis-shaped
// write. Drift compares host groups against the CONFIRMED live `group_ids` field
// only, so nothing here manufactures false drift.
// =============================================================================

/** Recurrence frequency values accepted by the schedule object. */
export const SCHEDULE_FREQUENCIES = ['One-Time', 'Daily', 'Weekly', 'Monthly'] as const

export const MAX_SCHEDULED_TASK_NAME_LENGTH = 255

/** Known schedule keys and the JS type each expects. */
const SCHEDULE_SCHEMA: Record<string, 'string' | 'number' | 'array'> = {
  frequency: 'string',
  interval: 'number',
  time: 'string',
  timezone: 'string',
  start_time: 'string',
  end_time: 'string',
  days_of_week: 'array',
  day_of_month: 'number',
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ITScheduledTaskSpec {
  sectionName: string
  /** Veltrix-side label (not sent to the API). */
  name: string
  taskId: string
  hostGroups: string[]
  /** Raw schedule JSON text as entered (empty string when none). */
  scheduleRaw: string
  timezone?: string
  enabled: boolean
}

/** Shape of a scheduled task returned by GET /it-automation/entities/scheduled-tasks/v1. */
export interface LiveScheduledTask {
  id?: string
  task_id?: string
  is_active?: boolean
  schedule?: Record<string, unknown>
  group_ids?: unknown
  group_names?: unknown
  target?: unknown
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
  updated_by?: string
  updated_timestamp?: string
}

/** Each canvas section describes one scheduled task. */
export function extractScheduledTaskSpecs(canvas: CanvasSnapshot): ITScheduledTaskSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      taskId: typeof fields.taskId === 'string' ? fields.taskId.trim() : '',
      hostGroups: splitList(fields.hostGroups),
      scheduleRaw: typeof fields.schedule === 'string' ? fields.schedule.trim() : '',
      timezone:
        typeof fields.timezone === 'string' && fields.timezone.trim()
          ? fields.timezone.trim()
          : undefined,
      enabled: coerceBoolean(fields.enabled, false),
    }
  })
}

export interface ScheduleResult {
  /** Normalized schedule object, or undefined when empty. */
  schedule?: Record<string, unknown>
  errors: string[]
  warnings: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and structurally validate the schedule JSON into the API `schedule`
 * shape, merging the separate timezone field when the schedule omits one.
 * Known-key type/enum mismatches are errors; unknown keys are warnings so a
 * forward-compatible field is never blocked. The verified API takes a STRUCTURED
 * recurrence (frequency/interval/time/days), not a raw cron string.
 */
export function parseSchedule(raw: string, timezone?: string): ScheduleResult {
  if (!raw) return { errors: [], warnings: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      errors: [
        `Schedule is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}. ` +
          'Provide a recurrence object, e.g. {"frequency": "Daily", "interval": 1, "time": "02:00", "timezone": "UTC"}.',
      ],
      warnings: [],
    }
  }
  if (!isPlainObject(parsed)) {
    return {
      errors: ['Schedule must be a JSON object describing the recurrence (frequency, interval, time, ...)'],
      warnings: [],
    }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const schedule: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(parsed)) {
    const expectedType = SCHEDULE_SCHEMA[key]
    if (!expectedType) {
      warnings.push(`Unknown schedule key "${key}" — sent through unvalidated`)
      schedule[key] = value
      continue
    }
    if (expectedType === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`Schedule "${key}" must be an array`)
        continue
      }
    } else if (typeof value !== expectedType) {
      errors.push(`Schedule "${key}" must be a ${expectedType}`)
      continue
    }
    if (key === 'frequency' && !(SCHEDULE_FREQUENCIES as readonly string[]).includes(value as string)) {
      errors.push(`Schedule "frequency" must be one of: ${SCHEDULE_FREQUENCIES.join(', ')}`)
      continue
    }
    if (key === 'interval' && (value as number) < 1) {
      errors.push('Schedule "interval" must be 1 or greater')
      continue
    }
    if (key === 'day_of_month' && ((value as number) < 1 || (value as number) > 31)) {
      errors.push('Schedule "day_of_month" must be between 1 and 31')
      continue
    }
    schedule[key] = value
  }

  // Merge the separate timezone field when the schedule did not set one.
  if (timezone && typeof schedule.timezone !== 'string') {
    schedule.timezone = timezone
  }

  return {
    schedule: Object.keys(schedule).length > 0 ? schedule : undefined,
    errors,
    warnings,
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scheduled task configurations against the Scheduled Task API
 * constraints: a Veltrix-side name, a task id (the API identity), a structured
 * recurrence schedule, and (captured, not pushed) host-group targeting.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScheduledTaskSpecs(ctx.canvas)
  const seenNames = new Set<string>()
  const seenTaskIds = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (Veltrix-side identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_SCHEDULED_TASK_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_SCHEDULED_TASK_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate name "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // taskId (API identity)
    if (!spec.taskId) {
      errors.push({ field: `${prefix}.taskId`, message: 'Task ID is required', code: 'required' })
    } else if (seenTaskIds.has(spec.taskId)) {
      // task_id is the API identity — one managed scheduled task per task.
      errors.push({
        field: `${prefix}.taskId`,
        message: `Duplicate task ID "${spec.taskId}" — only one scheduled task per task can be managed from this canvas`,
        code: 'duplicate_task_id',
      })
    } else {
      seenTaskIds.add(spec.taskId)
    }

    // schedule (required — a scheduled task needs a recurrence)
    if (!spec.scheduleRaw) {
      errors.push({
        field: `${prefix}.schedule`,
        message: 'Schedule is required — provide a recurrence object, e.g. {"frequency": "Daily", "interval": 1}',
        code: 'required',
      })
    } else {
      const { schedule, errors: scheduleErrors, warnings: scheduleWarnings } = parseSchedule(
        spec.scheduleRaw,
        spec.timezone,
      )
      for (const message of scheduleErrors) {
        errors.push({ field: `${prefix}.schedule`, message, code: 'invalid_schedule' })
      }
      for (const message of scheduleWarnings) {
        warnings.push({ field: `${prefix}.schedule`, message, code: 'unknown_schedule_key' })
      }
      if (scheduleErrors.length === 0 && !schedule) {
        errors.push({
          field: `${prefix}.schedule`,
          message: 'Schedule produced no recurrence fields',
          code: 'invalid_schedule',
        })
      }
    }

    // host groups — captured + validated, but NOT pushed (target shape unverified)
    if (spec.hostGroups.length === 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message:
          'No host groups declared — scheduled-task host targeting is captured but not yet pushed to the API (target shape unverified); complete targeting in the Falcon console if required',
        code: 'host_groups_not_pushed',
      })
    } else {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message:
          'Host groups are captured and drift-checked, but not written by deploy yet — the scheduled-task target field shape is not verified for this newer API',
        code: 'host_groups_not_pushed',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// --- Live-state helpers shared by deploy / drift -----------------------------

/** Read a live scheduled task's host group ids from the confirmed group_ids field. */
export function readLiveGroupIds(live: LiveScheduledTask): string[] | undefined {
  const source = live.group_ids
  if (source === undefined || source === null || !Array.isArray(source)) return undefined
  return source.map((g) => String(g)).filter((id) => id.length > 0)
}

/**
 * Flatten a schedule object into dot-path → value leaves so drift compares ONLY
 * the keys the canvas declared (unmanaged live keys never count as drift).
 */
export function flattenSchedule(obj: Record<string, unknown> | undefined, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (!obj) return out
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(value)) {
      for (const [k, v] of flattenSchedule(value, path)) out.set(k, v)
    } else {
      out.set(path, JSON.stringify(value))
    }
  }
  return out
}
