import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'
import type { LivePolicy } from '../../lib/policyAdapter'

// --- Sensor Update Policy API constraints -------------------------------------

/** platform_name is title-case in the API and immutable after creation. */
export const POLICY_PLATFORMS = ['Windows', 'Mac', 'Linux'] as const

export const UNINSTALL_PROTECTION_MODES = ['DISABLED', 'ENABLED', 'MAINTENANCE_MODE'] as const

export const MAX_POLICY_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

/** The policy `settings` object as the Sensor Update Policy API expects it. */
export interface SensorUpdateSettings {
  build?: string
  uninstall_protection?: string
  scheduler?: Record<string, unknown>
}

export interface PolicySpec {
  sectionName: string
  name: string
  platform: string
  description?: string
  enabled: boolean
  hostGroups: string[]
  /** Pinned sensor build, or undefined to leave the policy's current build. */
  build?: string
  uninstallProtection: string
}

/** Each canvas section describes one Falcon sensor update policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawPlatform = typeof fields.platform === 'string' ? fields.platform.trim() : 'Windows'
    const platform =
      (POLICY_PLATFORMS as readonly string[]).find(
        (p) => p.toLowerCase() === rawPlatform.toLowerCase(),
      ) ?? rawPlatform

    const rawProtection =
      typeof fields.uninstall_protection === 'string' && fields.uninstall_protection.trim()
        ? fields.uninstall_protection.trim().toUpperCase()
        : 'DISABLED'

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
      build:
        typeof fields.build === 'string' && fields.build.trim() ? fields.build.trim() : undefined,
      uninstallProtection: rawProtection,
    }
  })
}

/** Assemble the settings object deploy writes for a spec (only managed keys). */
export function buildSensorSettings(spec: PolicySpec): SensorUpdateSettings {
  const settings: SensorUpdateSettings = { uninstall_protection: spec.uninstallProtection }
  if (spec.build) settings.build = spec.build
  return settings
}

/** Read the build + uninstall_protection off a live policy's settings object. */
export function readSensorSettings(live: LivePolicy): SensorUpdateSettings {
  const raw = live.settings
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const obj = raw as Record<string, unknown>
  const settings: SensorUpdateSettings = {}
  if (typeof obj.build === 'string') settings.build = obj.build
  if (typeof obj.uninstall_protection === 'string') {
    settings.uninstall_protection = obj.uninstall_protection
  }
  return settings
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate sensor update policy configurations against Sensor Update Policy API
 * constraints: naming, platform names, host group targeting, and the settings
 * model (build pinning and uninstall protection mode).
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

    // uninstall protection mode
    if (!(UNINSTALL_PROTECTION_MODES as readonly string[]).includes(spec.uninstallProtection)) {
      errors.push({
        field: `${prefix}.uninstall_protection`,
        message: `Uninstall protection must be one of: ${UNINSTALL_PROTECTION_MODES.join(', ')}`,
        code: 'invalid_uninstall_protection',
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

    // no build means the policy's sensor version is left unmanaged
    if (!spec.build) {
      warnings.push({
        field: `${prefix}.build`,
        message: 'No sensor build specified — the policy will keep its current build unmanaged',
        code: 'no_build',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
