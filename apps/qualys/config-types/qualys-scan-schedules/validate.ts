import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

export const OCCURRENCE_VALUES = ['daily', 'weekly', 'monthly'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ScheduleSpec {
  sectionName: string
  scanTitle: string
  active: boolean
  optionTitle: string
  assetGroupTitles: string
  scheduleJson: string
}

/** Shape of a scan schedule parsed from a list response <SCAN> block. */
export interface LiveSchedule {
  id: string
  title: string
  active: boolean
  optionProfileTitle: string
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return fallback
}

/** The scan title natural key — a schedule's logical identity (title-keyed). */
export function scheduleKey(spec: { scanTitle: string }): string {
  return spec.scanTitle.trim().toLowerCase()
}

/**
 * Parse the schedule JSON into a FLAT object of scalar Qualys schedule params.
 * NON-UNION { value, error } (never a discriminated union — the platform loader
 * can't narrow those).
 */
export interface ScheduleParseResult {
  value: Record<string, unknown> | null
  error: string | null
}

export function parseScheduleObject(raw: string | undefined): ScheduleParseResult {
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
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      return { value: null, error: `must be a flat object of scalar parameters ("${key}" is not a scalar)` }
    }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** Each canvas item describes one Qualys scan schedule. */
export function extractScheduleSpecs(canvas: CanvasSnapshot): ScheduleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      scanTitle: typeof fields.scan_title === 'string' ? fields.scan_title.trim() : '',
      active: readBool(fields.active, true),
      optionTitle: typeof fields.option_title === 'string' ? fields.option_title.trim() : '',
      assetGroupTitles: typeof fields.asset_group_titles === 'string' ? fields.asset_group_titles.trim() : '',
      scheduleJson: typeof fields.schedule_json === 'string' ? fields.schedule_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scan schedule configurations: a scan title (unique) and option
 * profile title are required; the schedule JSON must parse to a flat object and
 * declare a supported `occurrence`; a target should be present.
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

    if (!spec.scanTitle) {
      errors.push({ field: `${prefix}.scan_title`, message: 'Scan title is required', code: 'required' })
    }
    if (!spec.optionTitle) {
      errors.push({ field: `${prefix}.option_title`, message: 'Option profile title is required', code: 'required' })
    }

    const parsed = parseScheduleObject(spec.scheduleJson)
    if (parsed.error) {
      errors.push({
        field: `${prefix}.schedule_json`,
        message: `Schedule ${parsed.error}`,
        code: spec.scheduleJson.trim() ? 'invalid_json' : 'required',
      })
    } else if (parsed.value) {
      const occurrence = typeof parsed.value.occurrence === 'string' ? parsed.value.occurrence.trim().toLowerCase() : ''
      if (!occurrence) {
        errors.push({
          field: `${prefix}.schedule_json`,
          message: 'Schedule must declare an "occurrence" (daily, weekly or monthly)',
          code: 'required',
        })
      } else if (!OCCURRENCE_VALUES.includes(occurrence as (typeof OCCURRENCE_VALUES)[number])) {
        errors.push({
          field: `${prefix}.schedule_json`,
          message: `Unsupported occurrence "${occurrence}" — use daily, weekly or monthly`,
          code: 'invalid_occurrence',
        })
      }

      // A schedule needs a target: asset groups (this app's field) or a target
      // key supplied inside the schedule JSON.
      const hasJsonTarget = ['ip', 'asset_groups', 'asset_group_ids', 'tag_set_include', 'fqdn'].some(
        (k) => parsed.value != null && parsed.value[k] != null && String(parsed.value[k]).trim() !== '',
      )
      if (!spec.assetGroupTitles && !hasJsonTarget) {
        warnings.push({
          field: `${prefix}.asset_group_titles`,
          message: 'No scan target set — provide asset group titles, or an ip/tag_set_include target in the schedule JSON',
          code: 'no_target',
        })
      }
    }

    if (spec.scanTitle) {
      const key = scheduleKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.scan_title`,
          message: `Duplicate scan schedule "${spec.scanTitle}" — each scan title may only be declared once`,
          code: 'duplicate_schedule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
