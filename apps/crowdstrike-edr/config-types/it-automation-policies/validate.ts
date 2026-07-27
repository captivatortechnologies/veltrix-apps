import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- Falcon for IT — IT Automation Policy API constraints ---------------------
//
// Verified against FalconPy `it_automation` (_endpoint + _payload/_it_automation).
// Policy entity: /it-automation/entities/policies/v1 (GET/POST/PATCH/DELETE),
// query: /it-automation/queries/policies/v1. The write body assembled by
// FalconPy's automation_policy_payload is:
//   { id?, name, description?, platform, is_enabled?, config: {
//       execution:   { enable_script_execution, enable_python_execution,
//                      enable_os_query, execution_timeout, execution_timeout_unit },
//       resources:   { cpu_throttle, cpu_scheduling, memory_pressure_level,
//                      memory_allocation, memory_allocation_unit },
//       concurrency: { concurrent_host_limit, concurrent_task_limit,
//                      concurrent_host_file_transfer_limit } } }
// Host-group assignment is a SEPARATE endpoint (policies-host-groups); precedence
// is another (policies-precedence) and is NOT managed here.
//
// UNVERIFIED (this collection is newer/stabilizing): the exact numeric bounds of
// execution_timeout / cpu_throttle and the enum values of cpu_scheduling /
// memory_pressure_level. Those are captured and structurally checked, but only
// enum values we can confirm (units, platforms) are hard-validated; unknown
// config keys are surfaced as warnings, not errors, so a forward-compatible
// field the user needs is never blocked.
// =============================================================================

/** platform is title-case in the API and immutable after creation. */
export const IT_POLICY_PLATFORMS = ['Windows', 'Mac', 'Linux'] as const

export const EXECUTION_TIMEOUT_UNITS = ['Hours', 'Minutes'] as const
export const MEMORY_ALLOCATION_UNITS = ['MB', 'GB'] as const

export const MAX_POLICY_NAME_LENGTH = 100
export const MAX_POLICY_DESCRIPTION_LENGTH = 500

/** Known config sub-objects and their fields, with the JS type each expects. */
const CONFIG_SCHEMA: Record<string, Record<string, 'boolean' | 'number' | 'string'>> = {
  execution: {
    enable_script_execution: 'boolean',
    enable_python_execution: 'boolean',
    enable_os_query: 'boolean',
    execution_timeout: 'number',
    execution_timeout_unit: 'string',
  },
  resources: {
    cpu_throttle: 'number',
    cpu_scheduling: 'string',
    memory_pressure_level: 'string',
    memory_allocation: 'number',
    memory_allocation_unit: 'string',
  },
  concurrency: {
    concurrent_host_limit: 'number',
    concurrent_task_limit: 'number',
    concurrent_host_file_transfer_limit: 'number',
  },
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ITPolicySpec {
  sectionName: string
  name: string
  platform: string
  enabled: boolean
  description?: string
  /** Raw executionConfig JSON text as entered (empty string when none). */
  configRaw: string
  hostGroups: string[]
}

/** Shape of a policy returned by GET /it-automation/entities/policies/v1. */
export interface LiveITPolicy {
  id?: string
  name?: string
  description?: string
  platform?: string
  is_enabled?: boolean
  enabled?: boolean
  config?: Record<string, unknown>
  host_groups?: unknown
  host_group_ids?: unknown
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
  updated_by?: string
  updated_timestamp?: string
}

/** Each canvas section describes one IT automation policy. */
export function extractITPolicySpecs(canvas: CanvasSnapshot): ITPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawPlatform = typeof fields.platform === 'string' ? fields.platform.trim() : 'Windows'
    const platform =
      (IT_POLICY_PLATFORMS as readonly string[]).find(
        (p) => p.toLowerCase() === rawPlatform.toLowerCase(),
      ) ?? rawPlatform

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      platform,
      enabled: coerceBoolean(fields.enabled, false),
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      configRaw: typeof fields.executionConfig === 'string' ? fields.executionConfig.trim() : '',
      hostGroups: splitList(fields.hostGroups),
    }
  })
}

export interface PolicyConfigResult {
  /** Parsed config object (only the keys the user declared), or undefined. */
  config?: Record<string, unknown>
  errors: string[]
  warnings: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and structurally validate the executionConfig JSON into the API `config`
 * shape. Only the sub-objects/keys the user declares are kept and pushed —
 * unmanaged settings keep their tenant values (mirrors prevention-policies).
 * Known-key type mismatches are errors; unknown keys are warnings so a
 * forward-compatible field is never blocked on a stabilizing collection.
 */
export function parsePolicyConfig(raw: string): PolicyConfigResult {
  if (!raw) return { errors: [], warnings: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      errors: [`Execution config is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
      warnings: [],
    }
  }
  if (!isPlainObject(parsed)) {
    return { errors: ['Execution config must be a JSON object with execution/resources/concurrency blocks'], warnings: [] }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const config: Record<string, unknown> = {}

  for (const [sectionKey, sectionValue] of Object.entries(parsed)) {
    const schema = CONFIG_SCHEMA[sectionKey]
    if (!schema) {
      warnings.push(`Unknown config block "${sectionKey}" — expected execution, resources, or concurrency`)
      config[sectionKey] = sectionValue
      continue
    }
    if (!isPlainObject(sectionValue)) {
      errors.push(`Config block "${sectionKey}" must be an object`)
      continue
    }

    const block: Record<string, unknown> = {}
    for (const [fieldKey, fieldValue] of Object.entries(sectionValue)) {
      const expectedType = schema[fieldKey]
      if (!expectedType) {
        warnings.push(`Unknown "${sectionKey}" setting "${fieldKey}" — sent through unvalidated`)
        block[fieldKey] = fieldValue
        continue
      }
      if (typeof fieldValue !== expectedType) {
        errors.push(`Config "${sectionKey}.${fieldKey}" must be a ${expectedType}`)
        continue
      }
      if (expectedType === 'number' && !Number.isFinite(fieldValue as number)) {
        errors.push(`Config "${sectionKey}.${fieldKey}" must be a finite number`)
        continue
      }
      if (fieldKey === 'cpu_throttle' && ((fieldValue as number) < 0 || (fieldValue as number) > 100)) {
        errors.push('Config "resources.cpu_throttle" must be between 0 and 100')
        continue
      }
      if (
        (fieldKey === 'execution_timeout' || fieldKey.startsWith('concurrent') || fieldKey === 'memory_allocation') &&
        (fieldValue as number) < 0
      ) {
        errors.push(`Config "${sectionKey}.${fieldKey}" must not be negative`)
        continue
      }
      if (
        fieldKey === 'execution_timeout_unit' &&
        !(EXECUTION_TIMEOUT_UNITS as readonly string[]).includes(fieldValue as string)
      ) {
        errors.push(`Config "execution.execution_timeout_unit" must be one of: ${EXECUTION_TIMEOUT_UNITS.join(', ')}`)
        continue
      }
      if (
        fieldKey === 'memory_allocation_unit' &&
        !(MEMORY_ALLOCATION_UNITS as readonly string[]).includes(fieldValue as string)
      ) {
        errors.push(`Config "resources.memory_allocation_unit" must be one of: ${MEMORY_ALLOCATION_UNITS.join(', ')}`)
        continue
      }
      block[fieldKey] = fieldValue
    }
    if (Object.keys(block).length > 0) config[sectionKey] = block
  }

  return {
    config: Object.keys(config).length > 0 ? config : undefined,
    errors,
    warnings,
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate IT automation policy configurations against the Policy API
 * constraints: naming length, immutable title-case platform, and the
 * execution/resources/concurrency config model.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractITPolicySpecs(ctx.canvas)
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

    // description length
    if (spec.description && spec.description.length > MAX_POLICY_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_POLICY_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // platform — title-case, immutable after creation
    if (!(IT_POLICY_PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${IT_POLICY_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    // executionConfig JSON
    const { config, errors: configErrors, warnings: configWarnings } = parsePolicyConfig(spec.configRaw)
    for (const message of configErrors) {
      errors.push({ field: `${prefix}.executionConfig`, message, code: 'invalid_config' })
    }
    for (const message of configWarnings) {
      warnings.push({ field: `${prefix}.executionConfig`, message, code: 'unknown_config_key' })
    }
    if (spec.configRaw && configErrors.length === 0 && !config) {
      warnings.push({
        field: `${prefix}.executionConfig`,
        message: 'Execution config produced no managed settings — the policy keeps Falcon defaults for every setting',
        code: 'empty_config',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// --- Live-state helpers shared by deploy / drift -----------------------------

/** Read a live policy's assigned host group ids from whichever field is present. */
export function readLiveHostGroups(live: LiveITPolicy): string[] | undefined {
  const source = live.host_group_ids ?? live.host_groups
  if (source === undefined || source === null) return undefined
  if (!Array.isArray(source)) return undefined
  return source
    .map((g) => (typeof g === 'string' ? g : isPlainObject(g) && typeof g.id === 'string' ? g.id : ''))
    .filter((id) => id.length > 0)
}

/** Whether the live policy exposes its enablement, and its value. */
export function readLiveEnabled(live: LiveITPolicy): boolean | undefined {
  if (typeof live.is_enabled === 'boolean') return live.is_enabled
  if (typeof live.enabled === 'boolean') return live.enabled
  return undefined
}

/**
 * Flatten a config object into dot-path → value leaves so drift can compare
 * ONLY the keys the canvas declared (unmanaged live keys never count as drift).
 * Object leaves recurse; arrays/primitives are compared by JSON value.
 */
export function flattenConfig(obj: Record<string, unknown> | undefined, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (!obj) return out
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isPlainObject(value)) {
      for (const [k, v] of flattenConfig(value, path)) out.set(k, v)
    } else {
      out.set(path, JSON.stringify(value))
    }
  }
  return out
}
