import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- Prevention Policy API constraints ----------------------------------------

/** platform_name is title-case in the API and immutable after creation. */
export const POLICY_PLATFORMS = ['Windows', 'Mac', 'Linux'] as const

export const ML_SLIDER_LEVELS = [
  'DISABLED',
  'CAUTIOUS',
  'MODERATE',
  'AGGRESSIVE',
  'EXTRA_AGGRESSIVE',
] as const

export const MAX_POLICY_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

/** One entry of the policy `settings` array as the API expects it. */
export interface PolicySetting {
  id: string
  value: Record<string, unknown>
}

export interface PolicySpec {
  sectionName: string
  name: string
  platform: string
  description?: string
  enabled: boolean
  hostGroups: string[]
  settingsRaw?: string
}

/** Shape of a policy returned by GET /policy/combined/prevention/v1. */
export interface LivePreventionPolicy {
  id?: string
  name?: string
  description?: string
  platform_name?: string
  enabled?: boolean
  groups?: Array<{ id?: string; name?: string }>
  prevention_settings?: Array<{
    name?: string
    settings?: Array<{ id?: string; name?: string; type?: string; value?: Record<string, unknown> }>
  }>
}

/** Each canvas section describes one Falcon prevention policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawPlatform = typeof fields.platform === 'string' ? fields.platform.trim() : 'Windows'
    // Normalize to the API's title-case platform names
    const platform =
      (POLICY_PLATFORMS as readonly string[]).find(
        (p) => p.toLowerCase() === rawPlatform.toLowerCase(),
      ) ?? rawPlatform

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      platform,
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      enabled: coerceBoolean(fields.enabled, false),
      hostGroups: splitList(fields.hostGroups),
      settingsRaw:
        typeof fields.settings === 'string' && fields.settings.trim()
          ? fields.settings.trim()
          : undefined,
    }
  })
}

/**
 * Parse and structurally validate the settings JSON. Each entry must be
 * {id, value} where value is either a toggle ({enabled: boolean}) or an ML
 * slider ({detection, prevention?} with known levels, prevention no more
 * aggressive than detection).
 */
export function parsePolicySettings(raw: string | undefined): {
  settings: PolicySetting[]
  errors: string[]
} {
  if (!raw) return { settings: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      settings: [],
      errors: [`Settings is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (!Array.isArray(parsed)) {
    return { settings: [], errors: ['Settings must be a JSON array of {id, value} entries'] }
  }

  const settings: PolicySetting[] = []
  const errors: string[] = []
  const seenIds = new Set<string>()
  const levelRank = (level: unknown): number =>
    ML_SLIDER_LEVELS.indexOf(level as (typeof ML_SLIDER_LEVELS)[number])

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Setting #${index + 1}: must be an object with "id" and "value"`)
      return
    }
    const { id, value } = entry as { id?: unknown; value?: unknown }

    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`Setting #${index + 1}: "id" must be a non-empty string`)
      return
    }
    if (seenIds.has(id)) {
      errors.push(`Setting "${id}": declared more than once`)
      return
    }
    seenIds.add(id)

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`Setting "${id}": "value" must be an object`)
      return
    }
    const valueObj = value as Record<string, unknown>

    const isToggle = 'enabled' in valueObj
    const isSlider = 'detection' in valueObj || 'prevention' in valueObj

    if (isToggle && isSlider) {
      errors.push(`Setting "${id}": value cannot mix toggle ("enabled") and slider ("detection"/"prevention") keys`)
      return
    }
    if (isToggle) {
      if (typeof valueObj.enabled !== 'boolean') {
        errors.push(`Setting "${id}": "enabled" must be true or false`)
        return
      }
    } else if (isSlider) {
      if (valueObj.detection === undefined) {
        errors.push(`Setting "${id}": slider settings require a "detection" level`)
        return
      }
      for (const key of ['detection', 'prevention'] as const) {
        if (valueObj[key] !== undefined && levelRank(valueObj[key]) === -1) {
          errors.push(
            `Setting "${id}": "${key}" must be one of ${ML_SLIDER_LEVELS.join(', ')}`,
          )
          return
        }
      }
      if (
        valueObj.prevention !== undefined &&
        levelRank(valueObj.prevention) > levelRank(valueObj.detection)
      ) {
        errors.push(
          `Setting "${id}": prevention level must not be more aggressive than detection level`,
        )
        return
      }
    } else {
      errors.push(
        `Setting "${id}": value must be a toggle ({"enabled": true}) or an ML slider ({"detection": "...", "prevention": "..."})`,
      )
      return
    }

    settings.push({ id: id.trim(), value: valueObj })
  })

  return { settings, errors }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate prevention policy configurations against Prevention Policy API
 * constraints: naming, platform names, host group targeting, and the
 * settings model (toggles and ML sliders).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_POLICY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name must be ${MAX_POLICY_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (spec.name.toLowerCase() === 'platform_default') {
        errors.push({
          field: `${prefix}.name`,
          message: 'The built-in default policy (platform_default) cannot be managed by this app',
          code: 'reserved_name',
        })
      }
      const key = `${spec.platform}:${spec.name.toLowerCase()}`
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" for platform ${spec.platform} — each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // platform — title-case, immutable after creation
    if (!(POLICY_PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${POLICY_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    // an enabled policy with no host groups protects nothing
    if (spec.enabled && spec.hostGroups.length === 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message:
          'Policy is enabled but assigned to no host groups — it will not apply to any hosts',
        code: 'no_host_groups',
      })
    }

    // settings JSON
    const { settings, errors: settingErrors } = parsePolicySettings(spec.settingsRaw)
    for (const message of settingErrors) {
      errors.push({ field: `${prefix}.settings`, message, code: 'invalid_settings' })
    }
    if (spec.settingsRaw && settingErrors.length === 0 && settings.length === 0) {
      warnings.push({
        field: `${prefix}.settings`,
        message: 'Settings array is empty — the policy will keep Falcon defaults for every setting',
        code: 'empty_settings',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Flatten a live policy's categorized prevention_settings into {id, value} pairs. */
export function flattenLiveSettings(live: LivePreventionPolicy): PolicySetting[] {
  const flat: PolicySetting[] = []
  for (const category of live.prevention_settings ?? []) {
    for (const setting of category.settings ?? []) {
      if (typeof setting.id === 'string' && setting.value && typeof setting.value === 'object') {
        flat.push({ id: setting.id, value: setting.value })
      }
    }
  }
  return flat
}
