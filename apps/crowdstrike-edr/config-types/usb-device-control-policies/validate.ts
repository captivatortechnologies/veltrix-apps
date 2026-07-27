import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'
import type { PolicyEndpoints } from '../../lib/policyAdapter'

// --- Device Control Policy API constraints ------------------------------------

/** platform_name is title-case in the API and immutable after creation. */
export const POLICY_PLATFORMS = ['Windows', 'Mac'] as const

/**
 * Enforcement actions a device class can be set to. Verified against the Falcon
 * console (Full Access / Full Block / Read Only / No Execute) and the
 * device-control settings schema. BLOCK_EXECUTE ("No Execute") applies to mass
 * storage only.
 */
export const DEVICE_CLASS_ACTIONS = ['FULL_ACCESS', 'FULL_BLOCK', 'READ_ONLY', 'BLOCK_EXECUTE'] as const

export const MAX_POLICY_NAME_LENGTH = 255

/**
 * Endpoints for the Device Control policy family. Create/update use the v2
 * entity (USB + Bluetooth settings schema); find uses the combined endpoint,
 * which only exists at v1 — there is no combined v2. Actions and delete are
 * v1-only in the API.
 */
export const DEVICE_CONTROL_ENDPOINTS: PolicyEndpoints = {
  entity: '/policy/entities/device-control/v2',
  combined: '/policy/combined/device-control/v1',
  actions: '/policy/entities/device-control-actions/v1',
  perPlatform: true,
}

/** DELETE has no v2 — rollback removes created policies via the v1 entity path. */
export const DEVICE_CONTROL_ENTITY_V1 = '/policy/entities/device-control/v1'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface DeviceControlSpec {
  sectionName: string
  name: string
  platform: string
  description?: string
  enabled: boolean
  hostGroups: string[]
  settingsRaw?: string
}

/** Each canvas section describes one Falcon device control policy. */
export function extractDeviceControlSpecs(canvas: CanvasSnapshot): DeviceControlSpec[] {
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

/** Narrow an unknown value to a plain JSON object, or null. */
export function asSettingsObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Parse and structurally validate the settings JSON. Phase 1 accepts the whole
 * `settings` object as user-supplied JSON: it must be an OBJECT with a `classes`
 * array whose entries each have a non-empty `id` and an allowed `action`. The
 * parsed object is returned so deploy can send it as-is.
 */
export function parseDeviceControlSettings(raw: string | undefined): {
  settings: Record<string, unknown> | null
  errors: string[]
} {
  if (!raw) return { settings: null, errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      settings: null,
      errors: [`Settings is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  const settings = asSettingsObject(parsed)
  if (!settings) {
    return { settings: null, errors: ['Settings must be a JSON object with a "classes" array'] }
  }

  const errors: string[] = []
  const classes = settings.classes
  if (!Array.isArray(classes)) {
    errors.push('Settings must contain a "classes" array')
    return { settings, errors }
  }

  const seenIds = new Set<string>()
  classes.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Class #${index + 1}: must be an object with "id" and "action"`)
      return
    }
    const { id, action, exceptions } = entry as {
      id?: unknown
      action?: unknown
      exceptions?: unknown
    }

    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`Class #${index + 1}: "id" must be a non-empty string (e.g. MASS_STORAGE)`)
      return
    }
    if (seenIds.has(id)) {
      errors.push(`Class "${id}": declared more than once`)
      return
    }
    seenIds.add(id)

    if (!(DEVICE_CLASS_ACTIONS as readonly string[]).includes(action as string)) {
      errors.push(`Class "${id}": "action" must be one of ${DEVICE_CLASS_ACTIONS.join(', ')}`)
      return
    }

    if (exceptions !== undefined && !Array.isArray(exceptions)) {
      errors.push(`Class "${id}": "exceptions" must be an array when present`)
    }
  })

  return { settings, errors }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate device control policy configurations against Device Control Policy
 * API constraints: naming, platform names, host group targeting, and the
 * per device-class settings model.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDeviceControlSpecs(ctx.canvas)
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

    // an enabled policy with no host groups enforces on nothing
    if (spec.enabled && spec.hostGroups.length === 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message:
          'Policy is enabled but assigned to no host groups — it will not apply to any hosts',
        code: 'no_host_groups',
      })
    }

    // settings JSON
    const { settings, errors: settingErrors } = parseDeviceControlSettings(spec.settingsRaw)
    for (const message of settingErrors) {
      errors.push({ field: `${prefix}.settings`, message, code: 'invalid_settings' })
    }
    const declaredClasses = settings && Array.isArray(settings.classes) ? settings.classes : null
    if (spec.settingsRaw && settingErrors.length === 0 && declaredClasses && declaredClasses.length === 0) {
      warnings.push({
        field: `${prefix}.settings`,
        message: 'Settings "classes" array is empty — the policy will keep Falcon defaults for every device class',
        code: 'empty_settings',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
