import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Microsoft Sentinel "Product Settings" — the workspace security-posture toggles
 * under Microsoft.SecurityInsights/settings. Each is a FIXED-NAME SINGLETON whose
 * settingsName equals its kind: Anomalies, EyesOn, EntityAnalytics, Ueba. A canvas
 * declares each at most once (they are singletons), reconciled by the setting name.
 *
 * The Settings operation group is PREVIEW-ONLY — it is not part of the stable
 * 2024-09-01 GA contract (Microsoft renders the Product Settings reference only
 * under preview api-versions), so every one of these settings is written/read
 * against the preview api-version below rather than lib/sentinel's GA
 * SENTINEL_API_VERSION. Verified against learn.microsoft.com Product Settings for
 * 2025-07-01-preview: Anomalies/EyesOn → properties.isEnabled, EntityAnalytics →
 * properties.entityProviders, Ueba → properties.dataSources.
 */
export const SENTINEL_SETTINGS_API_VERSION = '2025-07-01-preview'

/** The four fixed-name singleton settings (settingsName === kind). */
export const SETTING_NAMES = ['Anomalies', 'EyesOn', 'EntityAnalytics', 'Ueba'] as const
export type SettingName = (typeof SETTING_NAMES)[number]

/** Settings whose only knob is a boolean properties.isEnabled toggle. */
export const TOGGLE_SETTINGS = ['Anomalies', 'EyesOn'] as const
/** The EntityAnalytics entity providers synced (properties.entityProviders). */
export const ENTITY_PROVIDERS = ['ActiveDirectory', 'AzureActiveDirectory'] as const
/** The UEBA data sources enriched (properties.dataSources). */
export const UEBA_DATA_SOURCES = ['AuditLogs', 'AzureActivity', 'SecurityEvent', 'SigninLogs'] as const

/** True when the setting's value is the boolean isEnabled toggle (Anomalies / EyesOn). */
export function isToggleSetting(setting: string): boolean {
  return (TOGGLE_SETTINGS as readonly string[]).includes(setting)
}

/** One product setting authored on the canvas. */
export interface ProductSettingSpec {
  sectionName: string
  /** The singleton name (also the kind and the ARM settingsName). */
  setting: string
  /** Anomalies / EyesOn only — properties.isEnabled. */
  isEnabled: boolean
  /** EntityAnalytics only — properties.entityProviders. */
  entityProviders: string[]
  /** Ueba only — properties.dataSources. */
  dataSources: string[]
}

/** The reconciliation key is the setting name (lower-cased for matching). */
export function settingKey(setting: string): string {
  return setting.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

/** Read a tags/list field into a trimmed, de-duplicated string array (accepts a comma string too). */
export function readList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v).trim())
    : typeof value === 'string'
      ? value.split(',').map((v) => v.trim())
      : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of raw) {
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    out.push(v)
  }
  return out
}

/**
 * Each canvas item is one product setting. Fields irrelevant to the chosen
 * setting are normalised away so they never reach the request body, validation or
 * drift comparison (a Ueba item carries only dataSources, an Anomalies item only
 * isEnabled, and so on).
 */
export function extractProductSettingSpecs(canvas: CanvasSnapshot): ProductSettingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const setting = typeof fields.setting === 'string' ? fields.setting.trim() : ''
    return {
      sectionName: section.name,
      setting,
      isEnabled: isToggleSetting(setting) ? readBool(fields.enabled, true) : false,
      entityProviders: setting === 'EntityAnalytics' ? readList(fields.entity_providers) : [],
      dataSources: setting === 'Ueba' ? readList(fields.data_sources) : [],
    }
  })
}

/**
 * Validate product settings. Each item must name a supported singleton, declare
 * it at most once, and (for EntityAnalytics / Ueba) carry only values from the
 * allowed enum. Empty entityProviders / dataSources is legal — it turns the
 * feature off — so no minimum is imposed.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no product settings', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractProductSettingSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.setting) {
      errors.push({ field: `${prefix}.setting`, message: 'Setting is required', code: 'required' })
      continue
    }

    if (!SETTING_NAMES.includes(spec.setting as SettingName)) {
      errors.push({
        field: `${prefix}.setting`,
        message: `Setting must be one of ${SETTING_NAMES.join(', ')}`,
        code: 'invalid_setting',
      })
      continue
    }

    const key = settingKey(spec.setting)
    if (seen.has(key)) {
      errors.push({
        field: `${prefix}.setting`,
        message: `Duplicate setting "${spec.setting}" — each product setting is a singleton and may be declared only once`,
        code: 'duplicate_setting',
      })
    }
    seen.add(key)

    if (spec.setting === 'EntityAnalytics') {
      for (const provider of spec.entityProviders) {
        if (!ENTITY_PROVIDERS.includes(provider as (typeof ENTITY_PROVIDERS)[number])) {
          errors.push({
            field: `${prefix}.entity_providers`,
            message: `Invalid entity provider "${provider}" — must be one of ${ENTITY_PROVIDERS.join(', ')}`,
            code: 'invalid_entity_provider',
          })
        }
      }
    }

    if (spec.setting === 'Ueba') {
      for (const source of spec.dataSources) {
        if (!UEBA_DATA_SOURCES.includes(source as (typeof UEBA_DATA_SOURCES)[number])) {
          errors.push({
            field: `${prefix}.data_sources`,
            message: `Invalid UEBA data source "${source}" — must be one of ${UEBA_DATA_SOURCES.join(', ')}`,
            code: 'invalid_data_source',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
