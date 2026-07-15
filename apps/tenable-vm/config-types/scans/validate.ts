import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Scans API constraints ----------------------------------------------------

/**
 * settings.launch mirrors the recurrence FREQ. ON_DEMAND is an unscheduled scan
 * (launched manually) — it carries no rrules/starttime; every other value is a
 * recurring cadence.
 */
export const LAUNCH_CADENCES = [
  'ON_DEMAND',
  'ONETIME',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'YEARLY',
] as const
export type LaunchCadence = (typeof LAUNCH_CADENCES)[number]

/** settings.rrules BYDAY values (only meaningful for WEEKLY). */
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

export const MAX_SCAN_NAME_LENGTH = 255

/**
 * settings.starttime uses the COMPACT format `YYYYMMDDTHHMMSS` (NOT the spaced
 * exclusions format). e.g. 20240117T130000.
 */
export const STARTTIME_PATTERN = /^\d{8}T\d{6}$/

/**
 * A scan template UUID from GET /editor/scan/templates. Tenable template uuids
 * extend the standard 8-4-4-4-12 layout with extra hex in the final group, so
 * the trailing group is length 12-or-more rather than exactly 12.
 */
export const TEMPLATE_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12,}$/

// --- rrules assembler (shared by deploy / drift; unit-tested) -----------------

/**
 * Assemble the Tenable scan `settings.rrules` STRING from the launch cadence,
 * interval and days-of-week, e.g. `FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR`.
 *
 * ON_DEMAND has no recurrence — returns undefined so the caller omits rrules
 * entirely. BYDAY is only appended for WEEKLY (the one cadence where day-of-week
 * is meaningful) and only when at least one day is supplied. Note the API shape:
 * BYDAY (not byweekday), a semicolon-delimited STRING (not an object).
 */
export function assembleRrules(
  launch: string,
  interval: number,
  byday?: string,
): string | undefined {
  if (launch === 'ON_DEMAND') return undefined
  const safeInterval = Number.isFinite(interval) && interval >= 1 ? Math.trunc(interval) : 1
  const parts = [`FREQ=${launch}`, `INTERVAL=${safeInterval}`]
  if (launch === 'WEEKLY' && byday && byday.trim()) {
    parts.push(`BYDAY=${byday.trim()}`)
  }
  return parts.join(';')
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ScanSpec {
  sectionName: string
  name: string
  description?: string
  /** Scan TEMPLATE uuid (top-level `uuid` in the create/update body). */
  templateUuid: string
  /** Optional scan policy id to base the scan on (settings.policy_id). */
  policyId?: number
  /** Comma-separated string of IPs / ranges / CIDRs / FQDNs (API shape). */
  textTargets: string
  enabled: boolean
  /** ON_DEMAND | ONETIME | DAILY | WEEKLY | MONTHLY | YEARLY (settings.launch). */
  launch: string
  /** Compact YYYYMMDDTHHMMSS (settings.starttime); omitted for ON_DEMAND. */
  starttime?: string
  timezone?: string
  interval?: number
  /** Comma-joined subset of SU..SA, used to build the rrules BYDAY term. */
  byday?: string
}

/**
 * Shape of a scan as returned by GET /scans (list — flattened summary) and
 * GET /scans/{id} (detail — `{ info, settings }`). Fields are optional because
 * the two endpoints surface different subsets.
 */
export interface LiveScan {
  id?: number
  name?: string
  uuid?: string
  enabled?: boolean
  rrules?: string
  starttime?: string
  timezone?: string
  info?: {
    name?: string
    targets?: string
    policy_id?: number
  }
  settings?: {
    name?: string
    description?: string
    text_targets?: string
    policy_id?: number
    enabled?: boolean
    launch?: string
    starttime?: string
    timezone?: string
    rrules?: string
  }
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
 * Normalize a targets value (textarea string OR tags array) to the
 * comma-separated string the API expects. Splits on commas and newlines,
 * trims, and drops empties.
 */
function normalizeTargets(value: unknown): string {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : []
  return parts.map((p) => p.trim()).filter(Boolean).join(',')
}

/**
 * Normalize a byday value (tags array OR comma/space string) to the upper-cased,
 * comma-joined string used to build the rrules BYDAY term. Preserves order and
 * does not filter unknown tokens — validate reports those as errors.
 */
function normalizeWeekdays(value: unknown): string {
  const parts = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : []
  return parts.map((p) => p.trim().toUpperCase()).filter(Boolean).join(',')
}

/** Each canvas item describes one Tenable scan. */
export function extractScanSpecs(canvas: CanvasSnapshot): ScanSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const templateUuid =
      typeof fields.templateUuid === 'string' ? fields.templateUuid.trim() : ''
    const starttime =
      typeof fields.starttime === 'string' && fields.starttime.trim()
        ? fields.starttime.trim()
        : undefined
    const timezone =
      typeof fields.timezone === 'string' && fields.timezone.trim()
        ? fields.timezone.trim()
        : undefined
    const launch =
      typeof fields.launch === 'string' && fields.launch.trim()
        ? fields.launch.trim().toUpperCase()
        : 'ON_DEMAND'
    const byday = normalizeWeekdays(fields.byday) || undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      templateUuid,
      policyId: toNumber(fields.policyId),
      textTargets: normalizeTargets(fields.textTargets),
      enabled: toBool(fields.enabled, true),
      launch,
      starttime,
      timezone,
      interval: toNumber(fields.interval),
      byday,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scan configurations against Scans API constraints: naming, the scan
 * template uuid, targets, and the schedule shape (launch cadence, compact
 * starttime, interval and weekday tokens). An ON_DEMAND scan skips all
 * recurrence validation — it carries no rrules/starttime.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScanSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required + unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Scan name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_SCAN_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Scan name must be ${MAX_SCAN_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate scan "${spec.name}" — each scan may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // templateUuid — required; loose uuid-ish shape check
    if (!spec.templateUuid) {
      errors.push({
        field: `${prefix}.templateUuid`,
        message: 'Scan template UUID is required (from GET /editor/scan/templates)',
        code: 'required',
      })
    } else if (!TEMPLATE_UUID_PATTERN.test(spec.templateUuid)) {
      errors.push({
        field: `${prefix}.templateUuid`,
        message: 'Scan template UUID is malformed — copy it from GET /editor/scan/templates',
        code: 'invalid_uuid',
      })
    }

    // textTargets — required
    if (!spec.textTargets) {
      errors.push({
        field: `${prefix}.textTargets`,
        message: 'At least one target (IP, range, CIDR or FQDN) is required',
        code: 'required',
      })
    }

    // policyId — positive integer when present
    if (
      spec.policyId !== undefined &&
      (!Number.isInteger(spec.policyId) || spec.policyId < 1)
    ) {
      errors.push({
        field: `${prefix}.policyId`,
        message: 'Scan policy id must be a positive whole number',
        code: 'invalid_policy_id',
      })
    }

    // launch — must be in the allowed enum
    if (!(LAUNCH_CADENCES as readonly string[]).includes(spec.launch)) {
      errors.push({
        field: `${prefix}.launch`,
        message: `Launch cadence must be one of: ${LAUNCH_CADENCES.join(', ')}`,
        code: 'invalid_launch',
      })
    }

    // Recurrence constraints only apply to a scheduled scan — an ON_DEMAND scan
    // carries no rrules/starttime and skips the checks below.
    if (spec.launch === 'ON_DEMAND') continue

    // starttime — required and format-checked for a scheduled scan
    if (!spec.starttime) {
      errors.push({
        field: `${prefix}.starttime`,
        message: 'Start time is required when the cadence is not On demand',
        code: 'required',
      })
    } else if (!STARTTIME_PATTERN.test(spec.starttime)) {
      errors.push({
        field: `${prefix}.starttime`,
        message: 'Start time must be compact YYYYMMDDTHHMMSS (e.g. 20240117T130000)',
        code: 'invalid_starttime',
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

    // byday — every token must be a valid weekday abbreviation
    if (spec.byday) {
      const invalid = spec.byday
        .split(',')
        .filter((d) => !(WEEKDAYS as readonly string[]).includes(d))
      if (invalid.length > 0) {
        errors.push({
          field: `${prefix}.byday`,
          message: `Invalid day(s) "${invalid.join(', ')}" — use any of: ${WEEKDAYS.join(', ')}`,
          code: 'invalid_byday',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
