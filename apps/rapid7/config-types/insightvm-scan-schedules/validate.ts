import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ScheduleSpec {
  sectionName: string
  siteName: string
  scheduleName: string
  enabled: boolean
  scheduleJson: string
}

/** Shape of a scan schedule returned by GET /sites/{id}/scan_schedules. */
export interface LiveSchedule {
  id?: number
  scanName?: string
  enabled?: boolean
  scanTemplateId?: string
  start?: string
  duration?: string
  repeat?: unknown
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** The (siteName, scheduleName) natural key — a schedule's logical identity. */
export function scheduleKey(spec: { siteName: string; scheduleName: string }): string {
  return JSON.stringify([spec.siteName.toLowerCase(), spec.scheduleName])
}

/**
 * Parse the schedule JSON. NON-UNION { value, error } (never a discriminated
 * union — the platform loader can't narrow those).
 */
export interface JsonParseResult {
  value: Record<string, unknown> | null
  error: string | null
}

export function parseScheduleObject(raw: string | undefined): JsonParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: null, error: 'is required' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** Each canvas item describes one per-site scan schedule. */
export function extractScheduleSpecs(canvas: CanvasSnapshot): ScheduleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      siteName: typeof fields.site_name === 'string' ? fields.site_name.trim() : '',
      scheduleName: typeof fields.schedule_name === 'string' ? fields.schedule_name.trim() : '',
      enabled: readBool(fields.enabled, true),
      scheduleJson: typeof fields.schedule_json === 'string' ? fields.schedule_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scan schedule configurations: a site name, schedule name and schedule
 * JSON are required; the schedule JSON must parse to an object; and the
 * (siteName, scheduleName) natural key must be unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScheduleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.siteName) errors.push({ field: `${prefix}.site_name`, message: 'Site name is required', code: 'required' })
    if (!spec.scheduleName) errors.push({ field: `${prefix}.schedule_name`, message: 'Schedule name is required', code: 'required' })

    const parsed = parseScheduleObject(spec.scheduleJson)
    if (parsed.error) {
      errors.push({
        field: `${prefix}.schedule_json`,
        message: `Schedule ${parsed.error}`,
        code: spec.scheduleJson.trim() ? 'invalid_json' : 'required',
      })
    }

    if (spec.siteName && spec.scheduleName) {
      const key = scheduleKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.schedule_name`,
          message: `Duplicate schedule "${spec.scheduleName}" for site "${spec.siteName}" — each (site, schedule name) may only be declared once`,
          code: 'duplicate_schedule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
