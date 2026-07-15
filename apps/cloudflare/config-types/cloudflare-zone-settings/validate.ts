import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cloudflare zone settings -------------------------------------------------
//
// A zone setting is a per-zone singleton that ALWAYS exists — you never create
// or delete one, only read (GET /settings/{id}) and update (PATCH /settings/{id}
// with { value }). Identity is therefore the setting id itself (e.g. "ssl",
// "security_level", "min_tls_version"), not a server-assigned id.

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ZoneSettingSpec {
  sectionName: string
  settingId: string
  value: string
}

/** Shape of a setting returned by GET /settings/{id}. */
export interface LiveSetting {
  id?: string
  value?: unknown
  editable?: boolean
  modified_on?: string
}

/** The setting id is the logical identity — folded to lower case so "SSL" == "ssl". */
export function settingKey(settingId: string): string {
  return settingId.trim().toLowerCase()
}

/**
 * Normalize a live setting value to a comparable string. Most settings are
 * strings ("on"/"off"/"full"/"1.2"); some are numbers or booleans, and a few
 * are objects — stringify those so drift/health can compare against the declared
 * (text) value without throwing.
 */
export function normalizeSettingValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Each canvas item describes one Cloudflare zone setting. */
export function extractZoneSettingSpecs(canvas: CanvasSnapshot): ZoneSettingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      settingId: typeof fields.setting_id === 'string' ? fields.setting_id.trim() : '',
      value: typeof fields.value === 'string' ? fields.value.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate zone setting configurations: setting_id and value are required, and
 * each setting_id must be unique across the canvas (a setting is a singleton, so
 * declaring it twice is a conflict). There is no create/delete surface — the
 * handlers only GET then PATCH — so nothing else needs checking here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractZoneSettingSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.settingId) {
      errors.push({ field: `${prefix}.setting_id`, message: 'Setting id is required', code: 'required' })
    }
    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Setting value is required', code: 'required' })
    }

    if (spec.settingId) {
      const key = settingKey(spec.settingId)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.setting_id`,
          message: `Duplicate setting "${spec.settingId}" — each zone setting may only be declared once`,
          code: 'duplicate_setting',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
