import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ACS limits.conf constraints (adminconfig/v2/limits) ---------------------
//
// ACS exposes a small, fixed subset of limits.conf for editing. Each editable
// setting has a documented minimum, maximum and shipped default; ACS rejects an
// out-of-bounds value (HTTP 403). Values are integers — GET returns them as JSON
// strings, but the POST /limits/{stanza} body sends numbers.
// Docs: /adminconfig/v2/limits (GET /limits, GET|POST /limits/{stanza},
// GET /limits/{stanza}/{setting}). This app manages the editable subset below;
// stanzas/settings outside it are rejected here rather than at deploy time.

/** Bounds ACS enforces for one editable limits.conf setting. */
export interface LimitSettingSpec {
  min: number
  max: number
  default: number
}

/**
 * The editable stanza → setting subset ACS permits, with each setting's ACS
 * min/max/default. Sourced from the "Manage limits.conf configurations" ACS
 * manual page. A stanza or setting not in this map is not editable via ACS.
 */
export const ALLOWED_LIMITS: Record<string, Record<string, LimitSettingSpec>> = {
  join: {
    subsearch_maxout: { min: 0, max: 100000, default: 50000 },
    subsearch_maxtime: { min: 0, max: 120, default: 60 },
  },
  kv: {
    maxchars: { min: 1, max: 20480, default: 10240 },
    limit: { min: 1, max: 200, default: 100 },
    maxcols: { min: 256, max: 2048, default: 512 },
  },
  pdf: {
    max_rows_per_table: { min: 500, max: 5000, default: 1000 },
  },
  scheduler: {
    max_per_result_alerts: { min: 250, max: 5000, default: 500 },
    max_per_result_alerts_time: { min: 150, max: 1800, default: 300 },
  },
  searchresults: {
    maxresultrows: { min: 0, max: 1000000, default: 50000 },
  },
  spath: {
    extraction_cutoff: { min: 2500, max: 2000000, default: 5000 },
  },
  subsearch: {
    maxout: { min: 0, max: 10400, default: 10000 },
    maxtime: { min: 0, max: 120, default: 60 },
  },
}

/** The editable stanza names, e.g. for the canvas select and error messages. */
export const ALLOWED_STANZAS = Object.keys(ALLOWED_LIMITS)

/** Coerce a canvas value to an integer, or null when absent / non-numeric. */
export function coerceLimitValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface LimitSpec {
  sectionName: string
  stanza: string
  setting: string
  value: number | null
}

/** Each canvas item describes one limits.conf setting (stanza + setting + value). */
export function extractLimitSpecs(canvas: CanvasSnapshot): LimitSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      stanza: typeof fields.stanza === 'string' ? fields.stanza.trim() : '',
      setting: typeof fields.setting === 'string' ? fields.setting.trim() : '',
      value: coerceLimitValue(fields.value),
    }
  })
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate limits.conf settings against ACS constraints: each item's stanza and
 * setting must be in the editable subset ACS exposes, the value must be an
 * integer within the setting's ACS min/max, and duplicates are rejected.
 * Warnings flag values that are valid but risky — above Splunk's shipped default
 * (raises resource usage) or right at the ACS-permitted ceiling (no headroom).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seenSettings = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // Stanza
    const stanza = typeof fields.stanza === 'string' ? fields.stanza.trim() : ''
    let stanzaSettings: Record<string, LimitSettingSpec> | null = null
    if (!stanza) {
      errors.push({ field: `${prefix}.stanza`, message: 'Stanza is required', code: 'required' })
    } else if (!(stanza in ALLOWED_LIMITS)) {
      errors.push({
        field: `${prefix}.stanza`,
        message: `"${stanza}" is not an ACS-editable limits.conf stanza — use one of: ${ALLOWED_STANZAS.join(', ')}`,
        code: 'invalid_stanza',
      })
    } else {
      stanzaSettings = ALLOWED_LIMITS[stanza]
    }

    // Setting (validated against the chosen stanza's editable settings)
    const setting = typeof fields.setting === 'string' ? fields.setting.trim() : ''
    let settingSpec: LimitSettingSpec | null = null
    if (!setting) {
      errors.push({ field: `${prefix}.setting`, message: 'Setting is required', code: 'required' })
    } else if (stanzaSettings) {
      if (!(setting in stanzaSettings)) {
        errors.push({
          field: `${prefix}.setting`,
          message: `"${setting}" is not an ACS-editable setting for stanza "${stanza}" — use one of: ${Object.keys(stanzaSettings).join(', ')}`,
          code: 'invalid_setting',
        })
      } else {
        settingSpec = stanzaSettings[setting]
      }
    }

    // Duplicate stanza.setting across items — two values for one setting conflict.
    if (stanza && setting) {
      const key = `${stanza}.${setting}`
      if (seenSettings.has(key)) {
        errors.push({
          field: `${prefix}.setting`,
          message: `Duplicate setting "${key}" — declare each stanza/setting once`,
          code: 'duplicate_setting',
        })
      }
      seenSettings.add(key)
    }

    // Value
    const value = coerceLimitValue(fields.value)
    if (value === null) {
      errors.push({ field: `${prefix}.value`, message: 'Value is required', code: 'required' })
    } else if (!Number.isInteger(value)) {
      errors.push({
        field: `${prefix}.value`,
        message: `"${value}" is not valid — limits.conf values are integers`,
        code: 'invalid_value',
      })
    } else if (settingSpec) {
      if (value < settingSpec.min || value > settingSpec.max) {
        errors.push({
          field: `${prefix}.value`,
          message: `${value} is outside the ACS-permitted range for ${stanza}.${setting} (${settingSpec.min}–${settingSpec.max})`,
          code: 'value_out_of_range',
        })
      } else if (value === settingSpec.max) {
        warnings.push({
          field: `${prefix}.value`,
          message: `${stanza}.${setting} is set to the ACS-permitted maximum (${settingSpec.max}) — no headroom remains`,
          code: 'at_ceiling',
        })
      } else if (value > settingSpec.default) {
        warnings.push({
          field: `${prefix}.value`,
          message: `${stanza}.${setting} (${value}) is above Splunk's default (${settingSpec.default}) — raising this limit increases resource usage`,
          code: 'above_default',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
