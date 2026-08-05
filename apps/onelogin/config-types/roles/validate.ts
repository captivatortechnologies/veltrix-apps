import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- OneLogin Roles API constraints ---------------------------------------------
// https://developers.onelogin.com/api-docs/2/roles
//
// GET/POST        /api/2/roles           - list (bare array) / create
// GET/PUT/DELETE  /api/2/roles/{id}      - read / update (name only) / delete
// GET/PUT         /api/2/roles/{id}/apps - get / SET (full replace) assigned apps
//
// A role's logical identity in this config type is its NAME - OneLogin has no
// upsert, so this app matches an existing role by name (the same convention
// used across this app's other name-keyed config types: Apps, Mappings).

/** Turn a remote-multiselect value (array of option values) into a clean string list. */
export function toList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface RoleSpec {
  sectionName: string
  name: string
  /** App ids this role should be assigned to - a FULL REPLACE set (see canvas.yaml). */
  appIds: number[]
}

/** Shape of a role returned by GET /api/2/roles (list) and GET /api/2/roles/{id}. */
export interface LiveRole {
  id?: number
  name?: string
  [key: string]: unknown
}

/** Each canvas item describes one OneLogin role. */
export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      appIds: toList(fields.appIds)
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate role configurations against the OneLogin Roles API. Static only -
 * it never contacts OneLogin (the Apps picker is resolved live by the
 * platform's remote-select UI via options.ts, not here):
 *   - name is required and unique across the canvas
 *   - every declared appId (from the multiselect's raw value) must be a
 *     positive integer, in case a value was hand-edited via the canvas JSON
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRoleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName
    const rawFields = (sections.find((s) => s.name === spec.sectionName)?.fields ?? {}) as Record<string, unknown>

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate role "${spec.name}" - each role name may only be declared once per canvas`,
        code: 'duplicate_role',
      })
    }
    if (spec.name) seenNames.add(spec.name)

    const rawAppIds = toList(rawFields.appIds)
    const invalid = rawAppIds.filter((v) => !Number.isInteger(Number(v)) || Number(v) <= 0)
    if (invalid.length > 0) {
      errors.push({
        field: `${prefix}.appIds`,
        message: `Assigned Apps must be positive integer app ids (got: ${invalid.join(', ')})`,
        code: 'invalid_app_id',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
