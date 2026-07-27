import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'
import type { LivePolicy } from '../../lib/policyAdapter'

// --- Response (Real Time Response) Policy API constraints ----------------------

/** platform_name is title-case in the API and immutable after creation. */
export const POLICY_PLATFORMS = ['Windows', 'Mac', 'Linux'] as const

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

/** Each canvas section describes one Falcon response policy. */
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
 * Parse and structurally validate the settings JSON. Response policy settings
 * are capability toggles only — each entry must be {id, value:{enabled:boolean}}.
 * The ML slider keys prevention policies use (detection/prevention) are rejected
 * so a mis-pasted prevention setting is caught rather than silently sent.
 */
export function parseResponseSettings(raw: string | undefined): {
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

    if ('detection' in valueObj || 'prevention' in valueObj) {
      errors.push(
        `Setting "${id}": response policy settings are capability toggles ({"enabled": true/false}), not ML sliders`,
      )
      return
    }
    if (!('enabled' in valueObj)) {
      errors.push(`Setting "${id}": value must be a toggle ({"enabled": true} or {"enabled": false})`)
      return
    }
    if (typeof valueObj.enabled !== 'boolean') {
      errors.push(`Setting "${id}": "enabled" must be true or false`)
      return
    }

    settings.push({ id: id.trim(), value: { enabled: valueObj.enabled } })
  })

  return { settings, errors }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate response policy configurations against Response Policy API
 * constraints: naming, platform names, host group targeting, and the
 * toggles-only settings model.
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

    // an enabled policy with no host groups grants RTR to nothing
    if (spec.enabled && spec.hostGroups.length === 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message:
          'Policy is enabled but assigned to no host groups — it will not apply to any hosts',
        code: 'no_host_groups',
      })
    }

    // settings JSON
    const { settings, errors: settingErrors } = parseResponseSettings(spec.settingsRaw)
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

/**
 * Flatten a live response policy's `settings` into {id, value} pairs. Response
 * policy settings are a flat toggle array; a defensive branch also unwraps the
 * `{ settings: [...] }` object shape some Falcon policy families nest them in so
 * drift/rollback read the same values deploy writes.
 */
export function flattenLiveSettings(live: LivePolicy): PolicySetting[] {
  const raw = live.settings
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { settings?: unknown }).settings)
      ? ((raw as { settings: unknown[] }).settings)
      : []

  const flat: PolicySetting[] = []
  for (const setting of entries as Array<{ id?: unknown; value?: unknown }>) {
    if (typeof setting.id === 'string' && setting.value && typeof setting.value === 'object') {
      flat.push({ id: setting.id, value: setting.value as Record<string, unknown> })
    }
  }
  return flat
}
