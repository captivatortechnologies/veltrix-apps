import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Jamf Pro script constraints ---------------------------------------------

/** `priority` values accepted by the Script object (execution timing relative to a policy's other items). */
export const SCRIPT_PRIORITIES = ['BEFORE', 'AFTER', 'AT_REBOOT'] as const

/** Positional script parameter keys — Jamf reserves $1–$3 (mount point, computer name, username). */
export const PARAMETER_KEYS = [
  'parameter4',
  'parameter5',
  'parameter6',
  'parameter7',
  'parameter8',
  'parameter9',
  'parameter10',
  'parameter11',
] as const
export type ParameterKey = (typeof PARAMETER_KEYS)[number]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export type ScriptSpec = {
  sectionName: string
  name: string
  info: string
  notes: string
  priority: string
  categoryName: string
  osRequirements: string
  scriptContents: string
} & Record<ParameterKey, string>

/** Shape of a Jamf Pro Script object, as returned by list/get/create/update. */
export type LiveScript = {
  id?: string
  name?: string
  info?: string
  notes?: string
  priority?: string
  categoryId?: string
  categoryName?: string
  osRequirements?: string
  scriptContents?: string
} & Partial<Record<ParameterKey, string>>

/**
 * The script's logical identity: its name (case-insensitive, trimmed). NOTE:
 * Jamf Pro does not enforce unique script names server-side — if the live
 * tenant already has more than one script sharing a name, the FIRST one Jamf
 * returns (page order) is treated as the match. This app's own canvas rejects
 * duplicate names (see `validate` below) so ambiguity can only come from
 * scripts created outside Veltrix.
 */
export function scriptKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Build a name → live-script map, first match wins per `scriptKey` note above. */
export function indexScriptsByName(scripts: LiveScript[]): Map<string, LiveScript> {
  const byName = new Map<string, LiveScript>()
  for (const script of scripts) {
    if (!script.name) continue
    const key = scriptKey(script.name)
    if (!byName.has(key)) byName.set(key, script)
  }
  return byName
}

/** Each canvas item describes one Jamf Pro script. */
export function extractScriptSpecs(canvas: CanvasSnapshot): ScriptSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const parameters = Object.fromEntries(PARAMETER_KEYS.map((key) => [key, str(fields[key])])) as Record<
      ParameterKey,
      string
    >
    return {
      sectionName: section.name,
      name: str(fields.name),
      info: str(fields.info),
      notes: str(fields.notes),
      priority: str(fields.priority) || 'AFTER',
      categoryName: str(fields.category_name),
      osRequirements: str(fields.os_requirements),
      scriptContents: typeof fields.script_contents === 'string' ? fields.script_contents : '',
      ...parameters,
    }
  })
}

/** The `Script` request body Jamf Pro's create/update endpoints accept for a spec. */
export function buildScriptBody(spec: ScriptSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    info: spec.info,
    notes: spec.notes,
    priority: spec.priority,
    osRequirements: spec.osRequirements,
    scriptContents: spec.scriptContents,
  }
  // Omit categoryName entirely when unset — this app does not resolve names to
  // categoryId (that requires the separate /v1/categories endpoint, out of
  // scope for this self-contained config type), so an empty value would only
  // ever mean "leave uncategorized", which is Jamf Pro's own default.
  if (spec.categoryName) body.categoryName = spec.categoryName
  for (const key of PARAMETER_KEYS) body[key] = spec[key]
  return body
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Jamf Pro script configurations: a name and non-empty script
 * contents are required (Jamf Pro's own API does not require scriptContents,
 * but a script with none is never useful); the name must be unique across the
 * canvas (case-insensitive); and priority must be a supported value.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScriptSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Script name is required', code: 'required' })
    }

    if (!SCRIPT_PRIORITIES.includes(spec.priority as (typeof SCRIPT_PRIORITIES)[number])) {
      errors.push({
        field: `${prefix}.priority`,
        message: `Unsupported priority "${spec.priority}" (must be one of ${SCRIPT_PRIORITIES.join(', ')})`,
        code: 'invalid_priority',
      })
    }

    if (!spec.scriptContents) {
      errors.push({
        field: `${prefix}.script_contents`,
        message: 'Script contents are required',
        code: 'required',
      })
    }

    if (spec.name) {
      const key = scriptKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate script "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_script',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
