import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parseFlatScalarObject } from '../lib/qualysJson'

// Allowed values for a few well-documented VM option-profile parameters we can
// sanity-check without modelling the whole schema; any other key in settings_json
// is passed through to Qualys as-is.
export const PORT_SCAN_VALUES = ['none', 'standard', 'light', 'full'] as const
export const PERFORMANCE_VALUES = ['high', 'normal', 'low', 'custom'] as const
export const DETECTION_VALUES = ['complete', 'custom', 'runtime'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface OptionProfileSpec {
  sectionName: string
  title: string
  global: boolean
  isDefault: boolean
  settingsJson: string
}

/** Shape of a VM option profile parsed from an export BASIC_INFO block. */
export interface LiveOptionProfile {
  id: string
  title: string
  global: boolean
  isDefault: boolean
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return fallback
}

/** The title natural key — an option profile's logical identity (title-keyed). */
export function optionProfileKey(spec: { title: string }): string {
  return spec.title.trim().toLowerCase()
}

/** Each canvas item describes one Qualys VM option profile. */
export function extractOptionProfileSpecs(canvas: CanvasSnapshot): OptionProfileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      title: typeof fields.title === 'string' ? fields.title.trim() : '',
      global: readBool(fields.global, false),
      isDefault: readBool(fields.is_default, false),
      settingsJson: typeof fields.settings_json === 'string' ? fields.settings_json : '',
    }
  })
}

const ENUM_CHECKS: Array<{ key: string; values: readonly string[] }> = [
  { key: 'scan_tcp_ports', values: PORT_SCAN_VALUES },
  { key: 'scan_udp_ports', values: PORT_SCAN_VALUES },
  { key: 'scan_overall_performance', values: PERFORMANCE_VALUES },
  { key: 'vulnerability_detection', values: DETECTION_VALUES },
]

// --- Validate handler ---------------------------------------------------------

/**
 * Validate VM option profile configurations: a title is required and unique; the
 * scan settings, when present, must be a flat object of scalar parameters, and a
 * few well-known enum parameters are checked against their allowed values.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractOptionProfileSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.title) {
      errors.push({ field: `${prefix}.title`, message: 'Option profile title is required', code: 'required' })
    }

    const parsed = parseFlatScalarObject(spec.settingsJson, { allowEmpty: true })
    if (parsed.error) {
      errors.push({
        field: `${prefix}.settings_json`,
        message: `Scan settings ${parsed.error}`,
        code: 'invalid_json',
      })
    } else if (parsed.value) {
      for (const check of ENUM_CHECKS) {
        const raw = parsed.value[check.key]
        if (raw === undefined || raw === null || raw === '') continue
        const value = String(raw).trim().toLowerCase()
        if (!check.values.includes(value)) {
          errors.push({
            field: `${prefix}.settings_json`,
            message: `Unsupported ${check.key} "${raw}" — use one of ${check.values.join(', ')}`,
            code: 'invalid_value',
          })
        }
      }
    }

    if (spec.title) {
      const key = optionProfileKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.title`,
          message: `Duplicate option profile "${spec.title}" — each title may only be declared once`,
          code: 'duplicate_option_profile',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
