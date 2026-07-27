import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager recurring schedule constraints -----------------------------

export const MAX_NAME_LENGTH = 79
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
/** hh:mm on a 24-hour clock (00:00–23:59). */
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

export interface RecurringScheduleSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** One or more days of the week the schedule is valid. */
  days: string[]
  /** Time of day to start, format hh:mm. */
  start: string
  /** Time of day to end, format hh:mm. */
  end: string
}

/** A recurring schedule as returned by a get on the schedule/recurring table. */
export interface LiveRecurringSchedule {
  name?: string
  /** day is an array of weekday names (sometimes a space-joined string). */
  day?: string[] | string
  start?: string
  end?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a day value into lowercased weekday tokens (by newline, comma or space). */
export function splitDays(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,\s]+/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0).map((t) => t.toLowerCase()))]
}

/** Normalize a live day value to lowercased weekday names. */
export function liveDays(v: LiveRecurringSchedule['day']): string[] {
  return splitDays(v)
}

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value)
}

export function extractRecurringScheduleSpecs(canvas: CanvasSnapshot): RecurringScheduleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      days: splitDays(f.days),
      start: asString(f.start),
      end: asString(f.end),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRecurringScheduleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate schedule "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.days.length === 0) {
      errors.push({ field: `${prefix}.days`, message: 'A recurring schedule needs at least one day of the week', code: 'missing_days' })
    } else {
      for (const d of spec.days) {
        if (!(WEEKDAYS as readonly string[]).includes(d)) {
          errors.push({ field: `${prefix}.days`, message: `"${d}" is not a day of the week (${WEEKDAYS.join(', ')})`, code: 'invalid_day' })
        }
      }
    }

    if (!isValidTime(spec.start)) {
      errors.push({ field: `${prefix}.start`, message: 'Start must be a time of day in hh:mm form (e.g. 09:00)', code: 'invalid_time' })
    }
    if (!isValidTime(spec.end)) {
      errors.push({ field: `${prefix}.end`, message: 'End must be a time of day in hh:mm form (e.g. 17:00)', code: 'invalid_time' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
