import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

// Schedule objects (/Objects/Schedules) are referenced by name from security /
// authentication / decryption / PBF rules ("schedule" field) to restrict when a
// rule is active. Cited: PAN-OS REST API "Objects" category, class Schedules in
// the pypanrestv2 client (github.com/mrzepa/pypanrestv2, Objects.py) and the
// terraform-provider-panos panos_schedule resource (schedule_type.non_recurring
// / .recurring.daily / .recurring.weekly.<day>).
export const RESOURCE_PATH = '/Objects/Schedules'

export const SCHEDULE_KINDS = ['non_recurring', 'daily', 'weekly'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** "HH:MM-HH:MM" — a single daily/weekly time range. */
const TIME_RANGE_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
/** "YYYY/MM/DD@HH:MM-YYYY/MM/DD@HH:MM" — a single non-recurring date-time range. */
const NON_RECURRING_RE =
  /^\d{4}\/\d{2}\/\d{2}@([01]\d|2[0-3]):[0-5]\d-\d{4}\/\d{2}\/\d{2}@([01]\d|2[0-3]):[0-5]\d$/

export interface ScheduleSpec {
  sectionName: string
  name: string
  kind: string
  nonRecurring: string[]
  daily: string[]
  /** day -> comma-separated ranges (from a keyvalue canvas field). */
  weekly: Record<string, string>
}

interface LiveScheduleType {
  'non-recurring'?: { member?: string[] }
  recurring?: {
    daily?: { member?: string[] }
    weekly?: Partial<Record<Weekday, { member?: string[] }>>
  }
}

export interface LiveSchedule extends PanoramaEntry {
  'schedule-type'?: LiveScheduleType
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read a `keyvalue` canvas field into a plain string map — tolerates the array-of-pairs shape too. */
export function readKeyValueMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = str(rec.key ?? rec.name)
        if (key) out[key] = str(rec.value)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim()
      if (k) out[k] = str(v)
    }
  }
  return out
}

/** Split a comma-separated ranges string into trimmed, non-empty entries. */
function splitRanges(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

export function extractScheduleSpecs(canvas: CanvasSnapshot): ScheduleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      kind: str(fields.schedule_kind) || 'daily',
      nonRecurring: splitList(fields.non_recurring_ranges),
      daily: splitList(fields.daily_ranges),
      weekly: readKeyValueMap(fields.weekly_ranges),
    }
  })
}

/** Build the REST `schedule-type` element for the chosen kind. */
export function buildScheduleType(spec: ScheduleSpec): Record<string, unknown> {
  if (spec.kind === 'non_recurring') {
    return { 'non-recurring': { member: spec.nonRecurring } }
  }
  if (spec.kind === 'daily') {
    return { recurring: { daily: { member: spec.daily } } }
  }
  // weekly
  const weekly: Record<string, { member: string[] }> = {}
  for (const day of WEEKDAYS) {
    const ranges = splitRanges(spec.weekly[day] ?? '')
    if (ranges.length > 0) weekly[day] = { member: ranges }
  }
  return { recurring: { weekly } }
}

export function buildScheduleFields(spec: ScheduleSpec): Record<string, unknown> {
  return { 'schedule-type': buildScheduleType(spec) }
}

export function scheduleUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractScheduleSpecs(canvas)
    .filter((s) => s.name && SCHEDULE_KINDS.includes(s.kind as ScheduleKind))
    .map((s) => ({ name: s.name, fields: buildScheduleFields(s) }))
}

/** A normalized, order-insensitive summary string for drift comparison. */
export function scheduleSummary(spec: ScheduleSpec): string {
  if (spec.kind === 'non_recurring') return `non_recurring:${[...spec.nonRecurring].sort().join('|')}`
  if (spec.kind === 'daily') return `daily:${[...spec.daily].sort().join('|')}`
  const parts = WEEKDAYS.filter((d) => splitRanges(spec.weekly[d] ?? '').length > 0).map(
    (d) => `${d}=${splitRanges(spec.weekly[d] ?? '').sort().join('|')}`,
  )
  return `weekly:${parts.join(';')}`
}

function liveScheduleSummary(scheduleType: LiveScheduleType | undefined): string {
  if (!scheduleType) return 'none'
  if (scheduleType['non-recurring']) {
    const members = Array.isArray(scheduleType['non-recurring']!.member) ? scheduleType['non-recurring']!.member! : []
    return `non_recurring:${[...members].sort().join('|')}`
  }
  const recurring = scheduleType.recurring
  if (recurring?.daily) {
    const members = Array.isArray(recurring.daily.member) ? recurring.daily.member! : []
    return `daily:${[...members].sort().join('|')}`
  }
  if (recurring?.weekly) {
    const parts = WEEKDAYS.filter((d) => Array.isArray(recurring.weekly?.[d]?.member) && recurring.weekly![d]!.member!.length > 0).map(
      (d) => `${d}=${[...recurring.weekly![d]!.member!].sort().join('|')}`,
    )
    return `weekly:${parts.join(';')}`
  }
  return 'none'
}

export function scheduleDriftDiffs(spec: ScheduleSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveSchedule
  const expected = scheduleSummary(spec)
  const actual = liveScheduleSummary(live['schedule-type'])
  if (expected !== actual) {
    diffs.push({ field: `${spec.name}.schedule-type`, expected, actual, severity: 'warning' })
  }
  return diffs
}

/**
 * Validate schedules: a name is required and unique across the canvas; the
 * schedule kind is supported; non-recurring/daily entries match their date-time
 * format; and a weekly schedule declares at least one day with a valid range.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractScheduleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Schedule name is required', code: 'required' })
    }
    if (!SCHEDULE_KINDS.includes(spec.kind as ScheduleKind)) {
      errors.push({ field: `${prefix}.schedule_kind`, message: `Unsupported schedule kind "${spec.kind}"`, code: 'invalid_kind' })
    } else if (spec.kind === 'non_recurring') {
      if (spec.nonRecurring.length === 0) {
        errors.push({ field: `${prefix}.non_recurring_ranges`, message: 'At least one date-time range is required', code: 'required' })
      }
      for (const range of spec.nonRecurring) {
        if (!NON_RECURRING_RE.test(range)) {
          errors.push({ field: `${prefix}.non_recurring_ranges`, message: `Invalid range "${range}" — use YYYY/MM/DD@HH:MM-YYYY/MM/DD@HH:MM`, code: 'invalid_range' })
        }
      }
    } else if (spec.kind === 'daily') {
      if (spec.daily.length === 0) {
        errors.push({ field: `${prefix}.daily_ranges`, message: 'At least one time range is required', code: 'required' })
      }
      for (const range of spec.daily) {
        if (!TIME_RANGE_RE.test(range)) {
          errors.push({ field: `${prefix}.daily_ranges`, message: `Invalid range "${range}" — use HH:MM-HH:MM`, code: 'invalid_range' })
        }
      }
    } else {
      const days = WEEKDAYS.filter((d) => (spec.weekly[d] ?? '').trim().length > 0)
      if (days.length === 0) {
        errors.push({ field: `${prefix}.weekly_ranges`, message: 'At least one day needs a time range', code: 'required' })
      }
      for (const day of days) {
        for (const range of splitRanges(spec.weekly[day] ?? '')) {
          if (!TIME_RANGE_RE.test(range)) {
            errors.push({ field: `${prefix}.weekly_ranges`, message: `Invalid range "${range}" for ${day} — use HH:MM-HH:MM`, code: 'invalid_range' })
          }
        }
      }
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate schedule "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
