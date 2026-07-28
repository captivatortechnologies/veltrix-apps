import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/falcon'

// --- Flight Control (MSSP) User Group API constraints ------------------------

export const MAX_GROUP_NAME_LENGTH = 255

/** Falcon user UUIDs are standard 8-4-4-4-12 hexadecimal UUIDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface UserGroupSpec {
  sectionName: string
  name: string
  description?: string
  /** Member user UUIDs, normalized lowercase and de-duplicated. */
  userUuids: string[]
}

/** A live user group as returned by GET /mssp/entities/user-groups/v2. */
export interface LiveUserGroup {
  /** The group's own id — the value used as `user_group_id` in member/role bodies. */
  id?: string
  user_group_id?: string
  name?: string
  description?: string
  user_uuids?: string[]
  /** Modifier fields for drift attribution — MSSP entities may not expose these. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Lowercase and de-duplicate member UUIDs so identity comparisons are stable. */
export function normalizeUuids(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const uuid = raw.trim().toLowerCase()
    if (uuid && !seen.has(uuid)) {
      seen.add(uuid)
      out.push(uuid)
    }
  }
  return out
}

export function isValidUuid(uuid: string): boolean {
  return UUID_RE.test(uuid)
}

/** Each canvas section describes one user group. */
export function extractUserGroupSpecs(canvas: CanvasSnapshot): UserGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      userUuids: normalizeUuids(splitList(fields.userUuids)),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate MSSP user group configurations against the Flight Control API:
 * a required unique name within length limits and well-formed member UUIDs.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUserGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'User group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `User group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate user group "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    // member UUIDs
    for (const uuid of spec.userUuids) {
      if (!isValidUuid(uuid)) {
        errors.push({
          field: `${prefix}.userUuids`,
          message: `"${uuid}" is not a valid user UUID — expected an 8-4-4-4-12 hexadecimal UUID`,
          code: 'invalid_uuid',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
