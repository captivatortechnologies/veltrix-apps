import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'
import type { PolicyEndpoints } from '../../lib/policyAdapter'

// --- Content Update Policy API constraints -----------------------------------

/** Content update policies are NOT per-platform — there is no platform_name. */
export const CONTENT_UPDATE_ENDPOINTS: PolicyEndpoints = {
  entity: '/policy/entities/content-update/v1',
  combined: '/policy/combined/content-update/v1',
  actions: '/policy/entities/content-update-actions/v1',
  perPlatform: false,
}

/** Ring assignment per content category. `pause` is not permitted for system_critical. */
export const RING_ASSIGNMENTS = ['ga', 'ea', 'pause'] as const

/** The rapid-response content categories a policy assigns rings for. */
export const RING_CATEGORY_IDS = [
  'sensor_operations',
  'system_critical',
  'vulnerability_management',
  'rapid_response_al_bl_listing',
] as const

export const MAX_POLICY_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

/** One entry of the settings.ring_assignment_settings array as the API expects it. */
export interface RingAssignmentSetting {
  id: string
  ring_assignment: string
  /** Delay when the ring is `ga` — a string like "0", "1", "2", "4", "8", … */
  delay_hours?: string
}

/** The content update policy `settings` object as the API expects it. */
export interface ContentUpdateSettings {
  ring_assignment_settings: RingAssignmentSetting[]
  pinned_content_versions?: unknown
  [key: string]: unknown
}

export interface ContentUpdatePolicySpec {
  sectionName: string
  name: string
  description?: string
  enabled: boolean
  hostGroups: string[]
  settingsRaw?: string
}

/** Shape of a policy returned by GET /policy/combined/content-update/v1. */
export interface LiveContentUpdatePolicy {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  groups?: Array<{ id?: string; name?: string }>
  settings?: ContentUpdateSettings
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
  // Index signature keeps this assignable to the adapter's LivePolicy; the
  // explicit modifier fields above stay typed for attachDriftActor.
  [key: string]: unknown
}

/** Each canvas section describes one Falcon content update policy. */
export function extractContentUpdatePolicySpecs(canvas: CanvasSnapshot): ContentUpdatePolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
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
 * Parse and structurally validate the settings JSON. Must be an object with a
 * `ring_assignment_settings` array; each entry needs a non-empty `id` and a
 * `ring_assignment` of ga|ea|pause (pause is rejected for system_critical).
 * `delay_hours`, when present, must be a string.
 */
export function parseContentUpdateSettings(raw: string | undefined): {
  settings: ContentUpdateSettings | undefined
  errors: string[]
} {
  if (!raw) return { settings: undefined, errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      settings: undefined,
      errors: [`Settings is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      settings: undefined,
      errors: ['Settings must be a JSON object with a "ring_assignment_settings" array'],
    }
  }

  const obj = parsed as Record<string, unknown>
  const ringSettings = obj.ring_assignment_settings
  if (!Array.isArray(ringSettings)) {
    return { settings: undefined, errors: ['Settings must include a "ring_assignment_settings" array'] }
  }

  const errors: string[] = []
  const seenIds = new Set<string>()

  ringSettings.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Ring assignment #${index + 1}: must be an object with "id" and "ring_assignment"`)
      return
    }
    const { id, ring_assignment, delay_hours } = entry as {
      id?: unknown
      ring_assignment?: unknown
      delay_hours?: unknown
    }

    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`Ring assignment #${index + 1}: "id" must be a non-empty string`)
      return
    }
    if (seenIds.has(id)) {
      errors.push(`Ring assignment "${id}": declared more than once`)
      return
    }
    seenIds.add(id)

    if (!(RING_ASSIGNMENTS as readonly string[]).includes(ring_assignment as string)) {
      errors.push(`Ring assignment "${id}": "ring_assignment" must be one of ${RING_ASSIGNMENTS.join(', ')}`)
      return
    }
    if (ring_assignment === 'pause' && id === 'system_critical') {
      errors.push(`Ring assignment "${id}": "pause" is not permitted for system_critical`)
      return
    }
    if (delay_hours !== undefined && typeof delay_hours !== 'string') {
      errors.push(`Ring assignment "${id}": "delay_hours" must be a string`)
      return
    }
  })

  return { settings: obj as ContentUpdateSettings, errors }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate content update policy configurations against Content Update Policy
 * API constraints: naming, host group targeting, and the ring assignment
 * settings model (ga/ea/pause per content category).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractContentUpdatePolicySpecs(ctx.canvas)
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
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
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
    const { settings, errors: settingErrors } = parseContentUpdateSettings(spec.settingsRaw)
    for (const message of settingErrors) {
      errors.push({ field: `${prefix}.settings`, message, code: 'invalid_settings' })
    }
    if (settings && settingErrors.length === 0 && settings.ring_assignment_settings.length === 0) {
      warnings.push({
        field: `${prefix}.settings`,
        message: 'ring_assignment_settings is empty — the policy will keep Falcon default ring assignments',
        code: 'empty_settings',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
