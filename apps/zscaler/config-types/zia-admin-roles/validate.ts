import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Admin Roles constraints ---------------------------------------------

/** ZIA caps an admin role name at 255 characters. */
export const MAX_ROLE_NAME_LENGTH = 255

/** ZIA admin ranks run 1 (highest privilege) .. 7 (lowest); 7 is the default. */
export const DEFAULT_ROLE_RANK = 7

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AdminRoleSpec {
  sectionName: string
  /** The admin role name — its logical identity (list + match). */
  name: string
  /** Admin rank (defaulted here so downstream handlers stay simple). */
  rank: number
  /** Raw JSON permissionsAccess string; absent/blank = a role with defaults. */
  roleJson?: string
}

/** Shape of an admin role returned by GET /adminRoles. */
export interface LiveAdminRole {
  id?: number
  name?: string
  rank?: number
  /**
   * Marks a built-in / predefined role whose display name is a localization
   * tag. Built-in roles are read-only — deploy refuses to modify or delete them.
   */
  isNameL10nTag?: boolean
  [key: string]: unknown
}

/** Each canvas item describes one ZIA admin role. */
export function extractAdminRoleSpecs(canvas: CanvasSnapshot): AdminRoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    // rank may arrive as a number (default) or a string (typed input). A blank
    // input falls back to the default; a non-numeric string becomes NaN so
    // validate can flag it.
    const rawRank = fields.rank
    let rank: number
    if (typeof rawRank === 'number') {
      rank = rawRank
    } else if (typeof rawRank === 'string' && rawRank.trim() !== '') {
      rank = Number(rawRank.trim())
    } else {
      rank = DEFAULT_ROLE_RANK
    }

    const roleJson =
      typeof fields.role_json === 'string' && fields.role_json.trim()
        ? fields.role_json.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      rank,
      roleJson,
    }
  })
}

/**
 * Parse the raw role-permissions string, returning the object or null when the
 * string is not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body).
 */
export function parseRoleObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate admin role configurations against ZIA constraints: a name is
 * required (its logical identity), capped at 255 chars, and must be unique
 * across the canvas (matched case-insensitively, since ZIA rejects roles
 * differing only in case); `rank`, when set, must be a positive integer; and the
 * `role_json` escape hatch, when present, must parse to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAdminRoleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique (case-insensitive)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Admin role name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_ROLE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Admin role name must be ${MAX_ROLE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate admin role "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_admin_role',
        })
      }
      seen.add(key)
    }

    // rank — when provided it must be a positive integer
    if (!Number.isInteger(spec.rank) || spec.rank < 1) {
      errors.push({
        field: `${prefix}.rank`,
        message: 'Rank must be a positive integer (1 or greater)',
        code: 'invalid_rank',
      })
    }

    // role_json — optional; when present it must parse to a JSON object
    if (spec.roleJson && parseRoleObject(spec.roleJson) === null) {
      errors.push({
        field: `${prefix}.role_json`,
        message:
          'Role permissions must be a valid JSON object, e.g. {"policyAccess":"READ_WRITE","dashboardAccess":"READ_ONLY"} — leave blank for a role with default permissions',
        code: 'invalid_role_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
