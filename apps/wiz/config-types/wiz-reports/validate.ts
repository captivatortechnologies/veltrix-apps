import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Wiz report constraints ---------------------------------------------------

/**
 * This config type manages GRAPH_QUERY reports — a saved Wiz Security Graph query
 * run on demand or on an hourly schedule. The report `type` submitted to
 * `createReport` is the fixed value below.
 */
export const REPORT_TYPE_GRAPH_QUERY = 'GRAPH_QUERY'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ReportSpec {
  sectionName: string
  name: string
  projectId: string
  query: string
  /** Scheduled run interval in hours; null when the report is on-demand only. */
  runIntervalHours: number | null
  /** ISO-8601 start time for the schedule; empty when on-demand only. */
  runStartsAt: string
}

/** A report as returned by the `reports` list query. */
export interface LiveReport {
  id?: string
  name?: string
}

/** A report as returned by the single-report read query (full managed state). */
export interface FullReport {
  id?: string
  name?: string
  params?: { query?: unknown } | null
  runIntervalHours?: number | null
  runStartsAt?: string | null
}

/** The report's logical identity: its name (case-insensitive, trimmed). */
export function reportKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a canvas number-ish value, returning null when absent or invalid. */
export function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return null
}

/** Try to parse JSON text; empty text is treated as absent (ok, undefined value). */
export function tryParseJson(text: string): { value: unknown; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    return { value: JSON.parse(trimmed), ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

/** Each canvas item describes one Wiz graph-query report. */
export function extractReportSpecs(canvas: CanvasSnapshot): ReportSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      projectId: str(fields.project_id),
      query: typeof fields.query === 'string' ? fields.query.trim() : '',
      runIntervalHours: readNumber(fields.run_interval_hours),
      runStartsAt: str(fields.run_starts_at),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz report configurations: name is required and unique across the
 * canvas (case-insensitive); a graph query (valid JSON) is required; and a
 * schedule must pair a positive whole-hour interval with a valid ISO-8601 start
 * time (both or neither).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractReportSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Report name is required', code: 'required' })
    }

    if (!spec.query) {
      errors.push({ field: `${prefix}.query`, message: 'A graph query is required', code: 'required' })
    } else {
      const parsed = tryParseJson(spec.query)
      if (!parsed.ok || parsed.value === undefined) {
        errors.push({ field: `${prefix}.query`, message: 'The graph query must be valid JSON', code: 'invalid_json' })
      }
    }

    // Scheduling — interval and start time must be provided together.
    const hasInterval = spec.runIntervalHours !== null
    const hasStart = spec.runStartsAt !== ''
    if (hasInterval && (!Number.isInteger(spec.runIntervalHours) || (spec.runIntervalHours as number) <= 0)) {
      errors.push({
        field: `${prefix}.run_interval_hours`,
        message: 'Run interval must be a positive whole number of hours',
        code: 'invalid_interval',
      })
    }
    if (hasInterval && !hasStart) {
      errors.push({
        field: `${prefix}.run_starts_at`,
        message: 'A schedule start time is required when a run interval is set',
        code: 'required',
      })
    }
    if (hasStart && !hasInterval) {
      errors.push({
        field: `${prefix}.run_interval_hours`,
        message: 'A run interval is required when a schedule start time is set',
        code: 'required',
      })
    }
    if (hasStart && Number.isNaN(Date.parse(spec.runStartsAt))) {
      errors.push({
        field: `${prefix}.run_starts_at`,
        message: 'Schedule start time must be a valid ISO-8601 datetime, e.g. 2026-01-01T00:00:00Z',
        code: 'invalid_datetime',
      })
    }

    if (spec.name) {
      const key = reportKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate report "${spec.name}" — each report name may only be declared once`,
          code: 'duplicate_report',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
