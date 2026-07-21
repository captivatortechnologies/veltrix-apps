import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Groups API constraints ----------------------------------------------

/** Group name / description length caps (Okta profile limits). */
export const MAX_GROUP_NAME_LENGTH = 255
export const MAX_GROUP_DESCRIPTION_LENGTH = 1024

/**
 * Reserved / protected group names that are NOT OKTA_GROUP and therefore can
 * never be created, updated or deleted through this config type. "Everyone" is
 * Okta's BUILT_IN group. Compared case-insensitively. Deploy adds the real
 * guard (it can see a live group's `type`); validate rejects the one name it
 * can know statically so the author gets the error before a deploy runs.
 */
export const RESERVED_GROUP_NAMES = ['everyone']

// --- Spec extraction shared by deploy / rollback / healthCheck / drift ---------

export interface GroupSpec {
  sectionName: string
  /** Stable canvas item id — survives renames; used to match a live group by the
   *  external id stored from the prior deploy (rename-safe identity). */
  itemId?: string
  /** Group name — profile.name; the logical identity live groups are matched on. */
  name: string
  description?: string
  /**
   * Opt-in flag: when false, membership is never touched. When true, static
   * membership is reconciled to exactly `memberUserIds`.
   */
  manageMembership: boolean
  /** Okta user IDs — the desired exact static membership (only used when managing). */
  memberUserIds: string[]
}

/** Shape of a group returned by GET /groups (list) and GET /groups/{id} (get). */
export interface LiveGroup {
  id?: string
  /** OKTA_GROUP | BUILT_IN | APP_GROUP — only OKTA_GROUP is managed. */
  type?: string
  profile?: {
    name?: string
    description?: string | null
  }
  created?: string
  lastUpdated?: string
  _links?: unknown
  _embedded?: unknown
}

/** Shape of a user returned by GET /groups/{id}/users. */
export interface LiveGroupUser {
  id?: string
}

/** Coerce a canvas checkbox value to a boolean. Serializers may store it as a
 *  string or number; anything unrecognized keeps the default. */
export function coerceBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return defaultValue
}

/** Split a canvas `tags` value (array) or comma/newline string into trimmed ids. */
export function splitList(value: unknown): string[] {
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

/** Each canvas section describes one Okta group. */
export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined

    return {
      sectionName: section.name,
      itemId: section.id,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      manageMembership: coerceBoolean(fields.manageMembership, false),
      // De-dupe the desired member set so reconciliation math is stable.
      memberUserIds: [...new Set(splitList(fields.memberUserIds))],
    }
  })
}

/** True when a group name is reserved / protected (compared case-insensitively). */
export function isReservedGroupName(name: string): boolean {
  return RESERVED_GROUP_NAMES.includes(name.trim().toLowerCase())
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate group configurations against Okta Groups API constraints:
 * a name is required (<= 255 chars, and not a reserved built-in name),
 * the description is capped, and the group NAME — a group's logical identity —
 * must be unique across the canvas.
 *
 * Static rules only — NO network. It cannot see a live group's `type`, so the
 * BUILT_IN / APP_GROUP protection is enforced fully in deploy; here it rejects
 * only the reserved name it can know statically ("Everyone").
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
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, the logical identity, and not reserved
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (isReservedGroupName(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message:
            `"${spec.name}" is a reserved built-in group and cannot be managed — ` +
            'only Okta-mastered groups (OKTA_GROUP) may be created, updated or deleted here',
          code: 'reserved_name',
        })
      }
    }

    // description — optional, capped length
    if (spec.description && spec.description.length > MAX_GROUP_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_GROUP_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // Membership opt-in cross-checks — warnings, never errors.
    if (spec.manageMembership && spec.memberUserIds.length === 0) {
      warnings.push({
        field: `${prefix}.memberUserIds`,
        message:
          'Manage Membership is on but no member user IDs are listed — deploy will remove ALL ' +
          'current static members of this group',
        code: 'membership_clears_all',
      })
    }
    if (!spec.manageMembership && spec.memberUserIds.length > 0) {
      warnings.push({
        field: `${prefix}.memberUserIds`,
        message:
          'Member user IDs are listed but Manage Membership is off — they are ignored and the ' +
          "group's membership will not be touched",
        code: 'membership_ignored',
      })
    }

    // Group NAME is the logical identity — dedupe on it. Matched exactly (not
    // case-folded) so it agrees with the name-based live match in deploy / drift.
    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group "${spec.name}" — each group name may only be declared once per canvas`,
          code: 'duplicate_group',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
