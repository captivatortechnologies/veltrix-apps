import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/falcon'

// --- Falcon for IT — IT Automation Task API constraints -----------------------
//
// Verified against FalconPy `it_automation` (_endpoint + _payload/_it_automation).
// Task entity: /it-automation/entities/tasks/v1 (GET/POST/PATCH/DELETE),
// query: /it-automation/queries/tasks/v1 (filterable on name, task_type, ...).
// FalconPy's task_payload assembles (among others): name, description,
// task_type, os_query, queries{<platform>}, remediations{<platform>},
// output_parser_config, task_parameters[], target, access_type, id (update).
//
// VERIFIED keys we push: name, description, task_type, os_query (query tasks),
// remediations.<platform>.content (remediation tasks), task_parameters.
// UNVERIFIED / NOT pushed (this collection is newer/stabilizing): the exact
// `task_type` enum, whether `access_type`/`target` are required, and the
// required sub-keys of a remediation entry (action_type/language). Per the
// defensive contract these are captured/validated but not blindly sent — a
// wrong value fails loudly at deploy rather than manufacturing drift.
// =============================================================================

/** Task kind — 'query' reads state (osquery), 'remediation' changes it (script). */
export const TASK_TYPES = ['query', 'remediation'] as const
export type TaskType = (typeof TASK_TYPES)[number]

/** Sensor platforms a task's content targets. */
export const TASK_PLATFORMS = ['windows', 'mac', 'linux'] as const

export const MAX_TASK_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ITTaskSpec {
  sectionName: string
  name: string
  description?: string
  taskType: string
  platforms: string[]
  content: string
  /** Raw parameters JSON text as entered (empty string when none). */
  parametersRaw: string
}

/** One task parameter as the API expects it (only `key` is required here). */
export interface TaskParameter {
  key: string
  [field: string]: unknown
}

/** Shape of a task returned by GET /it-automation/entities/tasks/v1. */
export interface LiveITTask {
  id?: string
  name?: string
  description?: string
  task_type?: string
  os_query?: string
  queries?: Record<string, { content?: string } | undefined>
  remediations?: Record<string, { content?: string } | undefined>
  task_parameters?: Array<{ key?: string } & Record<string, unknown>>
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
  updated_by?: string
  updated_timestamp?: string
}

/** Each canvas section describes one IT automation task. */
export function extractITTaskSpecs(canvas: CanvasSnapshot): ITTaskSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      taskType: typeof fields.taskType === 'string' ? fields.taskType.trim().toLowerCase() : 'query',
      platforms: splitList(fields.platforms).map((p) => p.toLowerCase()),
      content: typeof fields.content === 'string' ? fields.content.trim() : '',
      parametersRaw: typeof fields.parameters === 'string' ? fields.parameters.trim() : '',
    }
  })
}

export interface TaskParametersResult {
  parameters: TaskParameter[]
  errors: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse and structurally validate the parameters JSON: a JSON array where each
 * entry is an object with a non-empty, unique `key`. All other fields are passed
 * through unvalidated (input_type, label, default_value, options, ...).
 */
export function parseTaskParameters(raw: string): TaskParametersResult {
  if (!raw) return { parameters: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      parameters: [],
      errors: [`Parameters is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }
  if (!Array.isArray(parsed)) {
    return { parameters: [], errors: ['Parameters must be a JSON array of {key, ...} objects'] }
  }

  const parameters: TaskParameter[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  parsed.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      errors.push(`Parameter #${index + 1}: must be an object with a "key"`)
      return
    }
    const key = entry.key
    if (typeof key !== 'string' || !key.trim()) {
      errors.push(`Parameter #${index + 1}: "key" must be a non-empty string`)
      return
    }
    if (seen.has(key)) {
      errors.push(`Parameter "${key}": declared more than once`)
      return
    }
    seen.add(key)
    parameters.push({ ...entry, key: key.trim() })
  })

  return { parameters, errors }
}

/** Parameter identity keys shared by deploy/drift. */
export function parameterKeys(parameters: TaskParameter[]): string[] {
  return parameters.map((p) => p.key)
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate IT automation task configurations against the Task API constraints:
 * a name, a known task type, valid platforms, non-empty content, and a
 * well-formed parameters array.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractITTaskSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Task name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_TASK_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Task name must be ${MAX_TASK_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate task "${spec.name}" — each task name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // task_type
    if (!(TASK_TYPES as readonly string[]).includes(spec.taskType)) {
      errors.push({
        field: `${prefix}.taskType`,
        message: `Task type must be one of: ${TASK_TYPES.join(', ')}`,
        code: 'invalid_task_type',
      })
    }

    // platforms
    if (spec.platforms.length === 0) {
      errors.push({
        field: `${prefix}.platforms`,
        message: `At least one platform is required: ${TASK_PLATFORMS.join(', ')}`,
        code: 'required',
      })
    } else {
      for (const platform of spec.platforms) {
        if (!(TASK_PLATFORMS as readonly string[]).includes(platform)) {
          errors.push({
            field: `${prefix}.platforms`,
            message: `Unknown platform "${platform}" — allowed: ${TASK_PLATFORMS.join(', ')}`,
            code: 'invalid_platform',
          })
        }
      }
    }

    // content
    if (!spec.content) {
      errors.push({
        field: `${prefix}.content`,
        message:
          spec.taskType === 'remediation'
            ? 'Script content is required for a remediation task'
            : 'osquery content is required for a query task',
        code: 'required',
      })
    }

    // parameters JSON
    const { parameters, errors: parameterErrors } = parseTaskParameters(spec.parametersRaw)
    for (const message of parameterErrors) {
      errors.push({ field: `${prefix}.parameters`, message, code: 'invalid_parameters' })
    }
    if (spec.parametersRaw && parameterErrors.length === 0 && parameters.length === 0) {
      warnings.push({
        field: `${prefix}.parameters`,
        message: 'Parameters array is empty — the task takes no input parameters',
        code: 'empty_parameters',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// --- Live-state helpers shared by deploy / drift -----------------------------

/** The task content this app manages for a spec, as the API expects it. */
export function buildTaskContent(spec: ITTaskSpec): Record<string, unknown> {
  if (spec.taskType === 'remediation') {
    const remediations: Record<string, { content: string }> = {}
    for (const platform of spec.platforms) remediations[platform] = { content: spec.content }
    return { remediations }
  }
  // query tasks use the dedicated platform-agnostic osquery field
  return { os_query: spec.content }
}

/** Read the live task's content for a given spec's shape, for drift comparison. */
export function readLiveContent(spec: ITTaskSpec, live: LiveITTask): string {
  if (spec.taskType === 'remediation') {
    for (const platform of spec.platforms) {
      const content = live.remediations?.[platform]?.content
      if (typeof content === 'string') return content
    }
    return ''
  }
  return typeof live.os_query === 'string' ? live.os_query : ''
}
