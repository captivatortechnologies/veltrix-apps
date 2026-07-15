import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SentinelOne group constraints -------------------------------------------

/** Message shown when the app is managing groups at a non-site scope. */
export const GROUPS_REQUIRE_SITE_SCOPE =
  'SentinelOne groups require the "site" scope — set the Scope setting to site.'

/** The name of the auto-created group that must never be modified or deleted. */
export const DEFAULT_GROUP_NAME = 'Default Group'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface GroupSpec {
  sectionName: string
  /** The group name — its logical identity within the site (list + match). */
  name: string
  description?: string
  /** Whether the group inherits its parent site's policy. */
  inherits: boolean
}

/** Shape of a group returned by GET /groups. */
export interface LiveGroup {
  id?: string
  name?: string
  description?: string
  inherits?: boolean
  siteId?: string
  type?: string
  isDefault?: boolean
}

/** Read a boolean field, defaulting to `fallback` when unset/non-boolean. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * True for a site's protected Default Group. SentinelOne auto-creates one per
 * site and it cannot be renamed, re-parented or deleted — so deploy refuses to
 * write to it and rollback can never remove it. Matched by the reserved name or
 * the API's own default flag.
 */
export function isDefaultGroup(group: LiveGroup): boolean {
  return group.name === DEFAULT_GROUP_NAME || group.isDefault === true
}

/** Each canvas item describes one SentinelOne group. */
export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      inherits: readBool(fields.inherits, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate group configurations against SentinelOne constraints: a name is
 * required and must be unique across the canvas (a group's identity within a
 * site). Declaring the reserved "Default Group" is warned about — deploy protects
 * it and will refuse to touch it.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
      continue
    }

    if (spec.name === DEFAULT_GROUP_NAME) {
      warnings.push({
        field: `${prefix}.name`,
        message: `"${DEFAULT_GROUP_NAME}" is the site's protected default group and cannot be managed here`,
        code: 'protected_group',
      })
    }

    if (seen.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate group "${spec.name}" — each group name may only be declared once per site`,
        code: 'duplicate_group',
      })
    }
    seen.add(spec.name)
  }

  return { valid: errors.length === 0, errors, warnings }
}
