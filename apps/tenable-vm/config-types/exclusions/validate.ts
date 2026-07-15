import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Exclusions API constraints ----------------------------------------------

/** schedule.rrules.freq is an enum on the Tenable Exclusions API. */
export const FREQUENCIES = ['ONETIME', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const
export type Frequency = (typeof FREQUENCIES)[number]

/** schedule.rrules.byweekday values (only meaningful for WEEKLY). */
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

export const MAX_EXCLUSION_NAME_LENGTH = 255

/**
 * starttime / endtime use the spaced format `YYYY-MM-DD HH:MM:SS` (NOT the
 * compact scan-schedule format). String comparison orders these correctly.
 */
export const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ExclusionSpec {
  sectionName: string
  name: string
  description?: string
  /** Comma-separated string of IPs / ranges / CIDRs / FQDNs (API shape). */
  members: string
  /** false = an "Always On" exclusion (schedule collapses to {enabled:false}). */
  enabled: boolean
  starttime?: string
  endtime?: string
  timezone?: string
  freq?: string
  interval?: number
  /** Comma-joined subset of SU..SA (API shape). */
  byweekday?: string
  bymonthday?: number
}

/** Shape of an exclusion returned by GET /exclusions and GET /exclusions/{id}. */
export interface LiveExclusion {
  id?: number | string
  uuid?: string
  name?: string
  description?: string
  members?: string
  network_id?: string
  schedule?: {
    enabled?: boolean
    starttime?: string
    endtime?: string
    timezone?: string
    rrules?: {
      freq?: string
      interval?: number
      byweekday?: string
      bymonthday?: number
    } | null
  } | null
}

/** Coerce a checkbox value to a boolean, falling back to a default when unset. */
function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/** Coerce a number-field value to a finite number, or undefined when unset. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Normalize a members value (textarea string OR tags array) to the
 * comma-separated string the API expects. Splits on commas and newlines,
 * trims, and drops empties.
 */
function normalizeMembers(value: unknown): string {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : []
  return parts.map((p) => p.trim()).filter(Boolean).join(',')
}

/**
 * Normalize a byweekday value (tags array OR comma/space string) to the
 * upper-cased, comma-joined string the API expects. Preserves order and does
 * not filter unknown tokens — validate reports those as errors.
 */
function normalizeWeekdays(value: unknown): string {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : []
  return parts.map((p) => p.trim().toUpperCase()).filter(Boolean).join(',')
}

/** Each canvas item describes one Tenable scan exclusion. */
export function extractExclusionSpecs(canvas: CanvasSnapshot): ExclusionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const starttime =
      typeof fields.starttime === 'string' && fields.starttime.trim()
        ? fields.starttime.trim()
        : undefined
    const endtime =
      typeof fields.endtime === 'string' && fields.endtime.trim()
        ? fields.endtime.trim()
        : undefined
    const timezone =
      typeof fields.timezone === 'string' && fields.timezone.trim()
        ? fields.timezone.trim()
        : undefined
    const freq =
      typeof fields.freq === 'string' && fields.freq.trim()
        ? fields.freq.trim().toUpperCase()
        : undefined
    const byweekday = normalizeWeekdays(fields.byweekday) || undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      members: normalizeMembers(fields.members),
      enabled: toBool(fields.enabled, true),
      starttime,
      endtime,
      timezone,
      freq,
      interval: toNumber(fields.interval),
      byweekday,
      bymonthday: toNumber(fields.bymonthday),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate exclusion configurations against Exclusions API constraints:
 * naming, member targeting, and the schedule shape (datetime format,
 * frequency enum, interval/day-of-month ranges, weekday tokens). A disabled
 * ("Always On") exclusion skips all schedule validation.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractExclusionSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required + unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Exclusion name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_EXCLUSION_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Exclusion name must be ${MAX_EXCLUSION_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate exclusion "${spec.name}" — each exclusion may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // members — required unless the exclusion is disabled ("Always On")
    if (spec.enabled && !spec.members) {
      errors.push({
        field: `${prefix}.members`,
        message: 'At least one member (IP, range, CIDR or FQDN) is required for an enabled exclusion',
        code: 'required',
      })
    }

    // Schedule constraints only apply when the schedule is enabled — a disabled
    // exclusion collapses to {enabled:false} and ignores the window/recurrence.
    if (!spec.enabled) continue

    // starttime / endtime — required and format-checked when enabled
    validateDatetime(errors, `${prefix}.starttime`, 'Start time', spec.starttime)
    validateDatetime(errors, `${prefix}.endtime`, 'End time', spec.endtime)
    if (
      spec.starttime &&
      spec.endtime &&
      DATETIME_PATTERN.test(spec.starttime) &&
      DATETIME_PATTERN.test(spec.endtime) &&
      spec.endtime <= spec.starttime
    ) {
      errors.push({
        field: `${prefix}.endtime`,
        message: 'End time must be after the start time',
        code: 'invalid_range',
      })
    }

    // freq — must be in the allowed enum when present
    if (spec.freq && !(FREQUENCIES as readonly string[]).includes(spec.freq)) {
      errors.push({
        field: `${prefix}.freq`,
        message: `Frequency must be one of: ${FREQUENCIES.join(', ')}`,
        code: 'invalid_freq',
      })
    }

    // interval — integer >= 1
    if (spec.interval !== undefined && (!Number.isInteger(spec.interval) || spec.interval < 1)) {
      errors.push({
        field: `${prefix}.interval`,
        message: 'Interval must be a whole number of 1 or more',
        code: 'invalid_interval',
      })
    }

    // bymonthday — 1..31
    if (
      spec.bymonthday !== undefined &&
      (!Number.isInteger(spec.bymonthday) || spec.bymonthday < 1 || spec.bymonthday > 31)
    ) {
      errors.push({
        field: `${prefix}.bymonthday`,
        message: 'Day of month must be a whole number from 1 to 31',
        code: 'invalid_monthday',
      })
    }

    // byweekday — every token must be a valid weekday abbreviation
    if (spec.byweekday) {
      const invalid = spec.byweekday.split(',').filter((d) => !(WEEKDAYS as readonly string[]).includes(d))
      if (invalid.length > 0) {
        errors.push({
          field: `${prefix}.byweekday`,
          message: `Invalid day(s) "${invalid.join(', ')}" — use any of: ${WEEKDAYS.join(', ')}`,
          code: 'invalid_weekday',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Report a missing (required) or malformed datetime for an enabled schedule. */
function validateDatetime(
  errors: ValidationResult['errors'],
  field: string,
  label: string,
  value: string | undefined,
): void {
  if (!value) {
    errors.push({ field, message: `${label} is required when the schedule is enabled`, code: 'required' })
  } else if (!DATETIME_PATTERN.test(value)) {
    errors.push({ field, message: `${label} must be in YYYY-MM-DD HH:MM:SS format`, code: 'invalid_datetime' })
  }
}
