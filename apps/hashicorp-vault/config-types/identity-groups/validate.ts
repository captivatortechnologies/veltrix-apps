import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault identity group constraints ----------------------------------------

/**
 * A group name is the logical identity and is used in the
 * /identity/group/name/{name} path — restrict it to a URL-safe charset.
 */
export const GROUP_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

/** The two identity group types. `type` is IMMUTABLE after a group is created. */
export const INTERNAL_TYPE = 'internal'
export const EXTERNAL_TYPE = 'external'
export const GROUP_TYPES: string[] = [INTERNAL_TYPE, EXTERNAL_TYPE]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface GroupSpec {
  sectionName: string
  /** Group name — the logical identity (path segment for /identity/group/name/{name}). */
  name: string
  /** 'internal' | 'external'. Defaults to 'internal'. IMMUTABLE after creation. */
  type: string
  /** Vault ACL policy names attached to the group. */
  policies: string[]
  /** Member entity IDs — internal groups only (rejected for external). */
  memberEntityIds: string[]
  /** Member (nested) group IDs — internal groups only (rejected for external). */
  memberGroupIds: string[]
  /** Raw metadata JSON string (a flat object of string values); undefined when blank. */
  metadataJson?: string
}

/** Shape of a group returned by GET /identity/group/name/{name} (under `data`). */
export interface LiveGroup {
  id?: string
  name?: string
  type?: string
  policies?: string[]
  member_entity_ids?: string[]
  member_group_ids?: string[]
  metadata?: Record<string, string> | null
  creation_time?: string
  modify_index?: number
  alias?: Record<string, unknown> | null
}

/** Trim a raw group name to its canonical form (the empty string for non-strings). */
export function normalizeGroupName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Fold a raw type value to a known group type, defaulting to 'internal' when blank. */
export function normalizeGroupType(raw: unknown): string {
  if (typeof raw === 'string' && raw.trim()) return raw.trim().toLowerCase()
  return INTERNAL_TYPE
}

/** Split a canvas `tags` value (array) or comma/newline string into trimmed, de-duped ids. */
export function splitList(value: unknown): string[] {
  let items: string[]
  if (Array.isArray(value)) {
    items = value.map((v) => String(v).trim())
  } else if (typeof value === 'string') {
    items = value.split(/[,\n]/).map((v) => v.trim())
  } else {
    return []
  }
  return [...new Set(items.filter((v) => v.length > 0))]
}

/**
 * Parse a raw metadata string, returning the object or null when the string is
 * not a JSON OBJECT (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseMetadataObject(raw: string): Record<string, unknown> | null {
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

/** True when every value in a metadata object is a string (Vault stores map[string]string). */
export function metadataValuesAreStrings(obj: Record<string, unknown>): boolean {
  return Object.values(obj).every((v) => typeof v === 'string')
}

/** Each canvas section describes one Vault identity group. */
export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const metadataJson =
      typeof fields.metadataJson === 'string' && fields.metadataJson.trim()
        ? fields.metadataJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: normalizeGroupName(fields.name),
      type: normalizeGroupType(fields.type),
      policies: splitList(fields.policies),
      memberEntityIds: splitList(fields.memberEntityIds),
      memberGroupIds: splitList(fields.memberGroupIds),
      metadataJson,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate identity group configurations against Vault's group model (no
 * network):
 *   - name is required, URL-safe, and unique per canvas (the logical identity)
 *   - type is 'internal' or 'external'
 *   - EXTERNAL groups may not carry member lists — their membership is managed
 *     by Vault via group-aliases at login, so any authored members are an ERROR
 *   - metadata, when set, is a flat JSON object of string values
 *
 * The type-immutability guard (a live group's type cannot be changed) needs the
 * live group and therefore lives in deploy; validate is static only.
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

    // name — required, URL-safe charset, unique (the group's logical identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
    } else {
      if (!GROUP_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Group name may contain only letters, digits, and the characters _ . -',
          code: 'invalid_name',
        })
      }
      // The group NAME is the logical identity — dedupe on it (matched exactly,
      // so the dedup key equals the upsert match key in deploy / drift).
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group name "${spec.name}" — each identity group may only be declared once per canvas`,
          code: 'duplicate_group',
        })
      }
      seenNames.add(spec.name)
    }

    // type — 'internal' or 'external' (immutable once the group is created)
    if (!GROUP_TYPES.includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: 'Group type must be "internal" or "external"',
        code: 'invalid_type',
      })
    }

    // EXTERNAL groups: membership is auth-managed via group-aliases — reject any
    // authored member lists outright (Vault would otherwise reject the write).
    if (spec.type === EXTERNAL_TYPE) {
      if (spec.memberEntityIds.length > 0) {
        errors.push({
          field: `${prefix}.memberEntityIds`,
          message:
            "An external group's members are managed by Vault via group-aliases — Member Entity IDs are not allowed. Leave them blank, or set the type to \"internal\".",
          code: 'external_members_not_allowed',
        })
      }
      if (spec.memberGroupIds.length > 0) {
        errors.push({
          field: `${prefix}.memberGroupIds`,
          message:
            "An external group's members are managed by Vault via group-aliases — Member Group IDs are not allowed. Leave them blank, or set the type to \"internal\".",
          code: 'external_members_not_allowed',
        })
      }
    }

    // metadata — optional; a flat JSON object of string values when present
    if (spec.metadataJson) {
      const metadata = parseMetadataObject(spec.metadataJson)
      if (metadata === null) {
        errors.push({
          field: `${prefix}.metadataJson`,
          message: 'Metadata must be a valid JSON object, e.g. {"team":"platform","env":"prod"}',
          code: 'invalid_metadata',
        })
      } else if (!metadataValuesAreStrings(metadata)) {
        errors.push({
          field: `${prefix}.metadataJson`,
          message: 'Metadata values must all be strings — Vault stores group metadata as string-to-string pairs',
          code: 'invalid_metadata_value',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
