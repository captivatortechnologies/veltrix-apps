import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Elasticsearch role-mapping API constraints ------------------------------

/** Role-mapping name length cap (kept generous; ES itself is lenient here). */
export const MAX_MAPPING_NAME_LENGTH = 255

/**
 * Recognised top-level operators of the role-mapping rules DSL. A rules object
 * combines these: `field` (a single predicate), `any` / `all` (arrays of
 * sub-rules) and `except` (negates a sub-rule). Used for a LIGHT validate check
 * only — a warning, never an error, since Elasticsearch validates the full DSL
 * on write.
 */
export const RULES_OPERATORS = ['field', 'any', 'all', 'except'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface MappingSpec {
  sectionName: string
  /** Mapping name — the logical identity carried in the PUT/GET/DELETE path. */
  name: string
  /** Whether the mapping is active (a disabled mapping grants nothing). */
  enabled: boolean
  /** Role names granted when the rules match. Exactly one of roles / role_templates; we model roles. */
  roles: string[]
  /**
   * Raw rules-DSL JSON string — the `rules` object (field/any/all/except).
   * Required; deploy re-parses it to build the API body.
   */
  rulesJson?: string
  /** Raw metadata JSON string — an optional object attached to the mapping. */
  metadataJson?: string
}

/**
 * One entry of GET /_security/role_mapping[/{name}] →
 * `{ "<name>": { enabled, roles, rules, metadata } }`. A mapping grants either
 * `roles` or `role_templates`; both are named so rollback can restore whichever
 * the prior mapping used.
 */
export interface LiveRoleMapping {
  enabled?: boolean
  roles?: string[]
  role_templates?: unknown[]
  rules?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/** The GET /_security/role_mapping response is a map keyed by mapping name. */
export type LiveRoleMappingResponse = Record<string, LiveRoleMapping>

/**
 * Coerce a checkbox value to a boolean, falling back to a default when unset.
 * Canvas serializers may store booleans as strings ("true"/"false") or numbers.
 */
export function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/** Split a `tags` field (array, or comma/newline string) into trimmed, non-empty strings. */
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

/** Each canvas section describes one role mapping. */
export function extractMappingSpecs(canvas: CanvasSnapshot): MappingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rulesJson =
      typeof fields.rulesJson === 'string' && fields.rulesJson.trim() ? fields.rulesJson.trim() : undefined
    const metadataJson =
      typeof fields.metadataJson === 'string' && fields.metadataJson.trim()
        ? fields.metadataJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      enabled: toBool(fields.enabled, true),
      roles: splitList(fields.roles),
      rulesJson,
      metadataJson,
    }
  })
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
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
 * Validate role-mapping configurations against Elasticsearch _security
 * constraints. Static rules only — NO network:
 *   - name is required (the logical identity, carried in the path) and capped
 *   - at least one role is required (a mapping that grants nothing is pointless)
 *   - the rules DSL is required and must parse to a JSON object; a light,
 *     WARN-only check nudges toward a recognised top-level operator
 *   - metadata is optional and, when present, must parse to a JSON object; keys
 *     beginning with `_` are reserved and are WARNED (Elasticsearch ignores /
 *     rejects author-set reserved keys such as `_reserved`)
 *   - the mapping NAME — a mapping's logical identity — must be unique.
 *
 * The RESERVED backstop (refusing any live mapping whose metadata._reserved is
 * true) is enforced in deploy, where the current server state is available.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMappingSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, capped, and the logical identity.
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role mapping name is required', code: 'required' })
    } else if (spec.name.length > MAX_MAPPING_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Role mapping name must be ${MAX_MAPPING_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // roles — at least one is required (we model the roles grant, not role_templates).
    if (spec.roles.length === 0) {
      errors.push({
        field: `${prefix}.roles`,
        message: 'At least one role is required — the mapping grants these role names when its rules match',
        code: 'required',
      })
    }

    // rulesJson — required, and must parse as a JSON object.
    if (!spec.rulesJson) {
      errors.push({
        field: `${prefix}.rulesJson`,
        message:
          'Rules DSL is required — provide the rules object, e.g. {"field":{"username":"*"}} or {"all":[…]}',
        code: 'required',
      })
    } else {
      const rules = parseJsonObject(spec.rulesJson)
      if (rules === null) {
        errors.push({
          field: `${prefix}.rulesJson`,
          message:
            'Rules must be a valid JSON object using the mapping DSL, e.g. {"any":[{"field":{"groups":"admins"}}]}',
          code: 'invalid_rules',
        })
      } else if (!RULES_OPERATORS.some((op) => op in rules)) {
        // A usable rules object needs a top-level operator; warn rather than
        // error so an unusual-but-valid body can still be pushed.
        warnings.push({
          field: `${prefix}.rulesJson`,
          message:
            'Rules has no recognised top-level operator (field / any / all / except) — Elasticsearch will reject it if malformed',
          code: 'unrecognized_rules',
        })
      }
    }

    // metadataJson — optional; when present it must parse as a JSON object, and
    // keys starting with `_` are reserved (Elasticsearch owns those, e.g. _reserved).
    if (spec.metadataJson) {
      const metadata = parseJsonObject(spec.metadataJson)
      if (metadata === null) {
        errors.push({
          field: `${prefix}.metadataJson`,
          message: 'Metadata must be a valid JSON object, e.g. {"team":"secops"} — leave blank for none',
          code: 'invalid_metadata',
        })
      } else {
        const reservedKeys = Object.keys(metadata).filter((k) => k.startsWith('_'))
        if (reservedKeys.length > 0) {
          warnings.push({
            field: `${prefix}.metadataJson`,
            message: `Metadata key(s) ${reservedKeys.join(', ')} start with "_" — those are reserved for Elasticsearch (e.g. _reserved) and are ignored / rejected on write`,
            code: 'reserved_metadata',
          })
        }
      }
    }

    // Mapping NAME is the logical identity — dedupe on it. Matched exactly (not
    // case-folded) so it agrees with the name-based live match in deploy / drift.
    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate role mapping "${spec.name}" — each mapping name may only be declared once per canvas`,
          code: 'duplicate_mapping',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
