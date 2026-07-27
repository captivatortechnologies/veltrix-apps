import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager one-time schedule constraints ------------------------------

export const MAX_NAME_LENGTH = 79
/** Schedule date-time, format hh:mm yyyy/mm/dd (24-hour clock). */
const DATETIME_RE = /^([01]?\d|2[0-3]):[0-5]\d \d{4}\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])$/

export interface OnetimeScheduleSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** Start date and time, format hh:mm yyyy/mm/dd. */
  start: string
  /** End date and time, format hh:mm yyyy/mm/dd. */
  end: string
}

/** A one-time schedule as returned by a get on the schedule/onetime table. */
export interface LiveOnetimeSchedule {
  name?: string
  start?: string
  end?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function isValidDateTime(value: string): boolean {
  return DATETIME_RE.test(value)
}

export function extractOnetimeScheduleSpecs(canvas: CanvasSnapshot): OnetimeScheduleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      start: asString(f.start),
      end: asString(f.end),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractOnetimeScheduleSpecs(ctx.canvas)
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

    if (!isValidDateTime(spec.start)) {
      errors.push({ field: `${prefix}.start`, message: 'Start must be a date-time in "hh:mm yyyy/mm/dd" form (e.g. 08:00 2026/01/01)', code: 'invalid_datetime' })
    }
    if (!isValidDateTime(spec.end)) {
      errors.push({ field: `${prefix}.end`, message: 'End must be a date-time in "hh:mm yyyy/mm/dd" form (e.g. 18:00 2026/01/07)', code: 'invalid_datetime' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
