import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Elasticsearch _security/role API constraints ----------------------------

/** Role name length cap (kept generous; ES itself is lenient here). */
export const MAX_ROLE_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RoleSpec {
  sectionName: string
  /** Role name — the logical identity carried in the PUT/GET/DELETE path. */
  name: string
  description?: string
  /** Cluster-level privilege names. */
  cluster: string[]
  /** Usernames this role may run as. */
  runAs: string[]
  /** Raw JSON-array string of index-permission objects; absent = no index grants. */
  indicesJson?: string
  /** Raw JSON-array string of application-privilege objects; absent = none. */
  applicationsJson?: string
  /** Raw JSON-object string of arbitrary metadata; absent = none. */
  metadataJson?: string
}

/** One entry of GET /_security/role[/{name}] → `{ "<name>": { cluster, indices, applications, run_as, metadata, description, ... } }`. */
export interface LiveRole {
  cluster?: string[]
  indices?: unknown[]
  applications?: unknown[]
  run_as?: string[]
  metadata?: Record<string, unknown>
  transient_metadata?: Record<string, unknown>
  description?: string
}

/** The GET /_security/role response is a map keyed by role name. */
export type LiveRoleResponse = Record<string, LiveRole>

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

/**
 * Parse a raw JSON string, returning the array or null when the string is not
 * a JSON ARRAY. Shared by validate (to reject bad input) and deploy (to build
 * the API body).
 */
export function parseJsonArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

/** Parse a raw JSON string, returning the object or null when it is not a JSON object. */
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

/** True when a live role is a RESERVED/built-in role, flagged via `metadata._reserved: true`. */
export function isReservedRole(role: LiveRole): boolean {
  const meta = role.metadata
  return (
    !!meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as Record<string, unknown>)._reserved === true
  )
}

/** Each canvas section describes one Elasticsearch role. */
export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const trimmed = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim() ? (fields[key] as string).trim() : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: trimmed('description'),
      cluster: splitList(fields.cluster),
      runAs: splitList(fields.runAs),
      indicesJson: trimmed('indicesJson'),
      applicationsJson: trimmed('applicationsJson'),
      metadataJson: trimmed('metadataJson'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate role configurations against Elasticsearch _security constraints.
 * Static rules only — NO network:
 *   - name is required, capped, and the logical identity (unique per canvas)
 *   - at least one of cluster / indicesJson / applicationsJson is required —
 *     Elasticsearch rejects a role that grants nothing
 *   - indicesJson / applicationsJson, when present, must parse to JSON ARRAYS
 *   - metadataJson, when present, must parse to a JSON object; keys starting
 *     with "_" are reserved and WARNED (Elasticsearch owns those, e.g. _reserved)
 *
 * The RESERVED backstop (refusing any live role whose metadata._reserved is
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

  const specs = extractRoleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else if (spec.name.length > MAX_ROLE_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Role name must be ${MAX_ROLE_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.indicesJson && parseJsonArray(spec.indicesJson) === null) {
      errors.push({
        field: `${prefix}.indicesJson`,
        message: 'Index Privileges must be a valid JSON array, e.g. [{"names":["logs-*"],"privileges":["read"]}]',
        code: 'invalid_indices',
      })
    }

    if (spec.applicationsJson && parseJsonArray(spec.applicationsJson) === null) {
      errors.push({
        field: `${prefix}.applicationsJson`,
        message:
          'Application Privileges must be a valid JSON array, e.g. [{"application":"kibana-.kibana","privileges":["all"],"resources":["*"]}]',
        code: 'invalid_applications',
      })
    }

    // A role must grant at least one privilege category — presence of a
    // non-blank JSON blob counts even if it fails to parse (that is reported
    // separately above; this check should not also fire a confusing second error).
    if (spec.cluster.length === 0 && !spec.indicesJson && !spec.applicationsJson) {
      errors.push({
        field: `${prefix}.cluster`,
        message:
          'A role must grant at least one of Cluster Privileges, Index Privileges or Application Privileges — Elasticsearch rejects a role that grants nothing',
        code: 'no_privileges',
      })
    }

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

    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate role "${spec.name}" — each role name may only be declared once per canvas`,
          code: 'duplicate_role',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
