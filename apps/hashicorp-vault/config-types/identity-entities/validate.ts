import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault identity entity constraints ---------------------------------------

/**
 * A Vault identity entity name is embedded in the path
 * `/identity/entity/name/{name}`, so it is restricted to a URL-safe set with no
 * whitespace or slashes. Entities have NO reserved/protected names in Vault.
 */
export const ENTITY_NAME_PATTERN = /^[A-Za-z0-9_.@-]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface EntitySpec {
  sectionName: string
  /** Entity name — the logical identity; the name-in-path used for every call. */
  name: string
  /** true = the entity is disabled (cannot authenticate); default false. */
  disabled: boolean
  /** ACL policy names attached directly to the entity (compared as a set). */
  policies: string[]
  /**
   * Raw metadata JSON string (a flat object of string values). Parsed lazily by
   * deploy / driftDetect via resolveMetadata; validate rejects a non-object or
   * a non-string value. Absent/blank means "no metadata".
   */
  metadataJson?: string
}

/**
 * Shape of the entity returned by GET /identity/entity/name/{name} (under a
 * `data` wrapper). Only the AUTHORED fields (policies, metadata, disabled) are
 * diffed; id, aliases, *group_ids and timestamps are server-computed and are
 * modelled here only so they can be explicitly ignored.
 */
export interface LiveEntity {
  id?: string
  name?: string
  policies?: string[]
  metadata?: Record<string, unknown> | null
  disabled?: boolean
  // Server-computed — never diffed.
  aliases?: unknown[]
  group_ids?: string[]
  direct_group_ids?: string[]
  inherited_group_ids?: string[]
  creation_time?: string
  last_update_time?: string
}

/** Coerce a checkbox value to a boolean, falling back to a default when unset. */
export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/**
 * Normalize a list value — canvas `tags` fields arrive as arrays (or comma /
 * newline text), and a live Vault list arrives as a JSON array. Blanks dropped.
 */
export function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/**
 * Parse a raw metadata string, returning the object or null when it is not a
 * JSON object (an array or primitive counts as invalid). Shared by validate (to
 * reject bad input) and resolveMetadata (to build the API body / drift compare).
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

/**
 * Resolve the authored metadata to Vault's map[string]string. Non-string values
 * are stringified defensively (validate rejects them first). Absent/blank ⇒ {}.
 */
export function resolveMetadata(metadataJson: string | undefined): Record<string, string> {
  if (!metadataJson) return {}
  const parsed = parseMetadataObject(metadataJson)
  if (!parsed) return {}
  return normalizeMetadata(parsed)
}

/** Coerce an arbitrary metadata object (live or authored) to map[string]string. */
export function normalizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val === undefined || val === null) continue
    out[key] = typeof val === 'string' ? val : String(val)
  }
  return out
}

/** Each canvas section describes one Vault identity entity. */
export function extractEntitySpecs(canvas: CanvasSnapshot): EntitySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const metadataJson =
      typeof fields.metadataJson === 'string' && fields.metadataJson.trim()
        ? fields.metadataJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      disabled: coerceBoolean(fields.disabled, false),
      policies: normalizeList(fields.policies),
      metadataJson,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate identity entity configurations against Vault's constraints (no
 * network): a name is required and URL-safe, any metadata is a flat JSON object
 * of string values, policy names carry no whitespace, and the entity NAME — the
 * logical identity — is unique across the canvas. Entities have no reserved
 * names, so there is no protected-name denylist. Entity ALIASES are out of
 * scope (they need a live mount_accessor and a separate endpoint).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractEntitySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, URL-safe, and the logical identity (unique per canvas)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Entity name is required', code: 'required' })
    } else {
      if (!ENTITY_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Entity name may contain only letters, digits, and the characters _ . @ - (no spaces or slashes)',
          code: 'invalid_name',
        })
      }
      // Matched exactly (not case-folded) so the dedup key equals the name-in-path
      // used by deploy / drift / healthCheck.
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate entity "${spec.name}" — each entity name may only be declared once per canvas`,
          code: 'duplicate_entity',
        })
      }
      seenNames.add(spec.name)
    }

    // policies — optional; each is a Vault policy name and must carry no whitespace
    for (const policy of spec.policies) {
      if (/\s/.test(policy)) {
        errors.push({
          field: `${prefix}.policies`,
          message: `Policy name "${policy}" is invalid — a Vault policy name contains no whitespace`,
          code: 'invalid_policy',
        })
      }
    }

    // metadataJson — optional; when present must be a flat JSON object of strings
    if (spec.metadataJson !== undefined) {
      const parsed = parseMetadataObject(spec.metadataJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.metadataJson`,
          message: 'Metadata must be a JSON object, e.g. {"team":"platform","tier":"gold"}',
          code: 'invalid_metadata',
        })
      } else {
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val !== 'string') {
            errors.push({
              field: `${prefix}.metadataJson`,
              message: `Metadata value for "${key}" must be a string — Vault entity metadata is a map of string to string (quote the value, e.g. "1")`,
              code: 'invalid_metadata_value',
            })
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
