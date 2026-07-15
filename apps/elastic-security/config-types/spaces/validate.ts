import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Kibana Spaces API constraints -------------------------------------------

/** Avatar initials are capped at 2 characters by Kibana. */
export const MAX_INITIALS_LENGTH = 2

/** A space id is URL-friendly: lowercase letters, digits, hyphen and underscore. */
export const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** Avatar color must be a 3- or 6-digit hex value. */
export const SPACE_COLOR_PATTERN = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/

/** The solution-view values Kibana accepts for a space (empty = leave unset). */
export const SPACE_SOLUTIONS = ['security', 'oblt', 'es', 'classic'] as const

/**
 * The built-in `default` space. It is PROTECTED: it can be UPDATED in place but
 * can never be created or deleted through this configuration. Kibana also flags
 * it (and any reserved space) with `_reserved: true` on read.
 */
export const PROTECTED_SPACE_ID = 'default'

/** True when an id refers to the protected built-in `default` space. */
export function isProtectedSpaceId(id: string | undefined | null): boolean {
  return typeof id === 'string' && id.trim().toLowerCase() === PROTECTED_SPACE_ID
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SpaceSpec {
  sectionName: string
  /** Space id — the IMMUTABLE logical identity and URL key. */
  id: string
  /** Display name shown in the space picker. */
  name: string
  description?: string
  /** Feature ids hidden in this space; always an array (possibly empty). */
  disabledFeatures: string[]
  /** Solution view (security|oblt|es|classic); absent/blank = leave unset. */
  solution?: string
  /** 1-2 character avatar initials. */
  initials?: string
  /** Hex avatar color, e.g. #0B64DD. */
  color?: string
}

/** Shape of a space returned by GET /api/spaces/space[/{id}]. */
export interface LiveSpace {
  id?: string
  name?: string
  description?: string
  disabledFeatures?: string[]
  solution?: string
  initials?: string
  color?: string
  imageUrl?: string
  /** Kibana marks the default (and other reserved) spaces as reserved. */
  _reserved?: boolean
}

/** Normalize a `tags` field (array, or comma/newline-separated string) to a list. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Each canvas section describes one Kibana space. */
export function extractSpaceSpecs(canvas: CanvasSnapshot): SpaceSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const trimmed = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim()
        ? (fields[key] as string).trim()
        : undefined

    return {
      sectionName: section.name,
      id: typeof fields.id === 'string' ? fields.id.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: trimmed('description'),
      disabledFeatures: toStringList(fields.disabledFeatures),
      solution: trimmed('solution'),
      initials: trimmed('initials'),
      color: trimmed('color'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate space configurations against Kibana Spaces API constraints (no
 * network): an id (URL-friendly, immutable) and a name are required, avatar
 * initials are capped at 2 characters, any avatar color is a hex value, any
 * solution view is one Kibana recognises, and the id — a space's logical
 * identity — must be unique across the canvas.
 *
 * PROTECTED default: the built-in `default` space can be UPDATED in place but
 * never removed. Declaring `default` with no name is the only way the fixed item
 * model can express "remove this space", so that is rejected (protected_default);
 * declaring it with a name is allowed (update-in-place) with an informative
 * warning that its id is immutable and it can never be created or deleted.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSpaceSpecs(ctx.canvas)
  const seenIds = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName
    const protectedDefault = isProtectedSpaceId(spec.id)

    // id — required, URL-friendly, immutable, the logical identity
    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Space id is required', code: 'required' })
    } else if (!SPACE_ID_PATTERN.test(spec.id)) {
      errors.push({
        field: `${prefix}.id`,
        message:
          'Space id must be URL-friendly: lowercase letters, digits, hyphens and underscores only, starting with a letter or digit',
        code: 'invalid_id',
      })
    }

    // name — required. For the protected default, a blank name is the only way
    // the model can express "delete this space", so it is rejected as such.
    if (!spec.name) {
      if (protectedDefault) {
        errors.push({
          field: `${prefix}.name`,
          message:
            'The "default" space is protected and cannot be removed — declaring it with no name would delete it. Provide a name to update it in place; the default space can never be created or deleted through this configuration.',
          code: 'protected_default',
        })
      } else {
        errors.push({ field: `${prefix}.name`, message: 'Space name is required', code: 'required' })
      }
    } else if (protectedDefault) {
      warnings.push({
        field: `${prefix}.id`,
        message:
          'The "default" space is protected — it can be updated in place but can never be created or deleted through this configuration, and its id is immutable.',
        code: 'protected_default',
      })
    }

    // solution — optional; when set it must be a value Kibana recognises
    if (spec.solution && !SPACE_SOLUTIONS.includes(spec.solution as (typeof SPACE_SOLUTIONS)[number])) {
      errors.push({
        field: `${prefix}.solution`,
        message: `Solution view must be one of: ${SPACE_SOLUTIONS.join(', ')} (or left unset)`,
        code: 'invalid_solution',
      })
    }

    // initials — optional, capped at 2 characters
    if (spec.initials && spec.initials.length > MAX_INITIALS_LENGTH) {
      errors.push({
        field: `${prefix}.initials`,
        message: `Avatar initials must be ${MAX_INITIALS_LENGTH} characters or fewer`,
        code: 'invalid_initials',
      })
    }

    // color — optional; when set it must be a hex value
    if (spec.color && !SPACE_COLOR_PATTERN.test(spec.color)) {
      errors.push({
        field: `${prefix}.color`,
        message: 'Avatar color must be a hex value such as #0B64DD (6-digit) or #07C (3-digit)',
        code: 'invalid_color',
      })
    }

    // id is the logical identity — dedupe on it. Matched case-insensitively
    // because Kibana space ids are lowercased, so two ids differing only in case
    // would collide on the same live space.
    if (spec.id) {
      const key = spec.id.toLowerCase()
      if (seenIds.has(key)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Duplicate space "${spec.id}" — each space id may only be declared once per canvas`,
          code: 'duplicate_space',
        })
      }
      seenIds.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
