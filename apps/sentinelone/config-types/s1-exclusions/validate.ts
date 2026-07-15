import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne exclusion constraints ---------------------------------------

export const EXCLUSION_TYPES = ['path', 'file_type', 'white_hash', 'certificate', 'browser'] as const
export const OS_TYPES = ['windows', 'windows_legacy', 'linux', 'macos'] as const
export const PATH_MODES = [
  'suppress',
  'disable_in_process_monitor',
  'disable_in_process_monitor_deep',
  'disable_all_monitors',
  'disable_all_monitors_deep',
] as const
export const PATH_EXCLUSION_TYPES = ['file', 'folder', 'subfolders'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ExclusionSpec {
  sectionName: string
  type: string
  value: string
  osType: string
  mode: string
  pathExclusionType: string
  description?: string
}

/** Shape of an exclusion returned by GET /exclusions. */
export interface LiveExclusion {
  id?: string
  type?: string
  value?: string
  osType?: string
  mode?: string
  pathExclusionType?: string
  description?: string
  source?: string
}

/** The (type, value, osType) natural key — an exclusion's logical identity at a scope. */
export function exclusionKey(spec: { type: string; value: string; osType: string }): string {
  return JSON.stringify([spec.type, spec.value, spec.osType])
}

/** Each canvas item describes one SentinelOne exclusion. */
export function extractExclusionSpecs(canvas: CanvasSnapshot): ExclusionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim() : undefined
    return {
      sectionName: section.name,
      type: typeof fields.type === 'string' ? fields.type.trim() : '',
      value: typeof fields.value === 'string' ? fields.value.trim() : '',
      osType: typeof fields.os_type === 'string' ? fields.os_type.trim() : '',
      mode: typeof fields.mode === 'string' && fields.mode.trim() ? fields.mode.trim() : 'disable_all_monitors',
      pathExclusionType:
        typeof fields.path_exclusion_type === 'string' && fields.path_exclusion_type.trim()
          ? fields.path_exclusion_type.trim()
          : 'folder',
      description,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate exclusion configurations against SentinelOne constraints: type, value
 * and OS are required and from the supported sets; path modes/scopes are checked
 * for the 'path' type; and the (type, value, osType) natural key must be unique
 * across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractExclusionSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Exclusion type is required', code: 'required' })
    } else if (!EXCLUSION_TYPES.includes(spec.type as (typeof EXCLUSION_TYPES)[number])) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported exclusion type "${spec.type}"`, code: 'invalid_type' })
    }
    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Exclusion value is required', code: 'required' })
    }
    if (!spec.osType) {
      errors.push({ field: `${prefix}.os_type`, message: 'OS is required', code: 'required' })
    } else if (!OS_TYPES.includes(spec.osType as (typeof OS_TYPES)[number])) {
      errors.push({ field: `${prefix}.os_type`, message: `Unsupported OS "${spec.osType}"`, code: 'invalid_os' })
    }
    if (spec.type === 'path') {
      if (!PATH_MODES.includes(spec.mode as (typeof PATH_MODES)[number])) {
        errors.push({ field: `${prefix}.mode`, message: `Unsupported path mode "${spec.mode}"`, code: 'invalid_mode' })
      }
      if (!PATH_EXCLUSION_TYPES.includes(spec.pathExclusionType as (typeof PATH_EXCLUSION_TYPES)[number])) {
        errors.push({ field: `${prefix}.path_exclusion_type`, message: `Unsupported path scope "${spec.pathExclusionType}"`, code: 'invalid_path_scope' })
      }
    }

    if (spec.type && spec.value && spec.osType) {
      const key = exclusionKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.value`,
          message: `Duplicate exclusion "${spec.type} ${spec.value} (${spec.osType})" — each (type, value, OS) may only be declared once`,
          code: 'duplicate_exclusion',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
