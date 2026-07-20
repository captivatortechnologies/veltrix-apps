import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Profile Mappings API constraints -----------------------------------
//
// A profile mapping transforms attributes FROM a source profile TO a target
// profile. It exists IMPLICITLY between a provisioned source profile and target
// profile — there is NO create and NO delete. This config type is UPDATE-ONLY and
// manages only the property mappings (the per-target-attribute expressions) on an
// existing mapping:
//   GET  /mappings?sourceId={id}&targetId={id}  — resolve the (source, target) mapping
//   GET  /mappings/{mappingId}                  — read one full mapping
//   POST /mappings/{mappingId}                  — add/update/remove property mappings
//
// Rules Okta enforces (mirrored here):
//   - the mapping OBJECT itself is never created or deleted — only updated.
//   - POST is a MERGE: only the target-property names you send are touched. To
//     REMOVE a property mapping you POST it as { expression: null, pushStatus: null }.
// This type only ever writes the declared target-property names; unmanaged property
// mappings on the same mapping are never pruned.

/** pushStatus values Okta accepts on a property mapping. */
export const PUSH_STATUSES = ['PUSH', 'DONT_PUSH'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface MappingSpec {
  sectionName: string
  /** Source UserType or app-instance id (e.g. oty… or 0oa…). */
  sourceId: string
  /** Target UserType or app-instance id (e.g. oty… or 0oa…) — the identity field. */
  targetId: string
  /**
   * Raw JSON string authored on the canvas: an object keyed by TARGET property name,
   * each value `{ expression, pushStatus }` for a set or `{ expression: null,
   * pushStatus: null }` for a removal. Undefined when the field is blank.
   */
  propertiesJson?: string
}

/**
 * Shape of a profile mapping returned by GET /mappings/{id} (and list entries).
 * `properties` is keyed by TARGET property name.
 */
export interface LiveMapping {
  id?: string
  source?: { id?: string; name?: string; type?: string }
  target?: { id?: string; name?: string; type?: string }
  properties?: Record<string, { expression?: string | null; pushStatus?: string | null }>
  _links?: unknown
  [k: string]: unknown
}

/**
 * Parse a raw JSON string, returning the object or null when it is not a JSON
 * object (a JSON array or primitive counts as invalid). The object's VALUES may be
 * null-bearing (a removal is `{ expression: null, pushStatus: null }`), but the top
 * level must be an object. Shared by validate (to reject bad input) and deploy/drift
 * (to build the API body / compare live state).
 */
export function parseConfigObject(raw: string): Record<string, unknown> | null {
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

/** Each canvas item describes the property mappings of one (source, target) mapping. */
export function extractMappingSpecs(canvas: CanvasSnapshot): MappingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const sourceId = typeof fields.sourceId === 'string' ? fields.sourceId.trim() : ''
    const targetId = typeof fields.targetId === 'string' ? fields.targetId.trim() : ''
    const propertiesJson =
      typeof fields.propertiesJson === 'string' && fields.propertiesJson.trim()
        ? fields.propertiesJson.trim()
        : undefined
    return { sectionName: section.name, sourceId, targetId, propertiesJson }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate profile-mapping configurations. Static only — NO network:
 *   - sourceId and targetId are required
 *   - the (sourceId, targetId) PAIR — the mapping's identity — is unique per canvas
 *   - propertiesJson is required and parses to a JSON OBJECT keyed by target property
 *   - each property value is an object that is either a SET (non-empty string
 *     expression + pushStatus in PUSH|DONT_PUSH) or a REMOVAL (expression === null
 *     AND pushStatus === null)
 *
 * The "mapping must already exist" rule depends on live state, so it is enforced in
 * deploy (a zero-result resolve is surfaced clearly).
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
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // sourceId / targetId — both required (they form the mapping identity).
    if (!spec.sourceId) {
      errors.push({
        field: `${prefix}.sourceId`,
        message: 'Source ID is required — the source UserType or app-instance id (e.g. "oty1a2b3c4" or "0oa1a2b3c4")',
        code: 'required',
      })
    }
    if (!spec.targetId) {
      errors.push({
        field: `${prefix}.targetId`,
        message: 'Target ID is required — the target UserType or app-instance id (e.g. "oty1a2b3c4" or "0oa1a2b3c4")',
        code: 'required',
      })
    }

    // (sourceId, targetId) PAIR is the mapping's logical identity — dedupe on it.
    if (spec.sourceId && spec.targetId) {
      const key = JSON.stringify([spec.sourceId, spec.targetId])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.targetId`,
          message: `Duplicate mapping for source "${spec.sourceId}" -> target "${spec.targetId}" — each (sourceId, targetId) pair may only be declared once per canvas`,
          code: 'duplicate_pair',
        })
      }
      seenPairs.add(key)
    }

    // propertiesJson — required, parses to a non-empty object of property mappings.
    if (!spec.propertiesJson) {
      errors.push({
        field: `${prefix}.propertiesJson`,
        message:
          'At least one property mapping is required — a JSON object keyed by TARGET property name (or {"expression":null,"pushStatus":null} to remove one)',
        code: 'required',
      })
      continue
    }

    const parsed = parseConfigObject(spec.propertiesJson)
    if (parsed === null) {
      errors.push({
        field: `${prefix}.propertiesJson`,
        message:
          'Property mappings must be a JSON OBJECT keyed by target property name, e.g. {"firstName":{"expression":"user.firstName","pushStatus":"PUSH"}}',
        code: 'invalid_properties',
      })
      continue
    }

    const names = Object.keys(parsed)
    if (names.length === 0) {
      errors.push({
        field: `${prefix}.propertiesJson`,
        message: 'Declare at least one property mapping',
        code: 'empty_properties',
      })
      continue
    }

    for (const name of names) {
      const val = parsed[name]
      if (typeof val !== 'object' || val === null || Array.isArray(val)) {
        errors.push({
          field: `${prefix}.propertiesJson`,
          message: `Property "${name}" must be an object {"expression","pushStatus"} — a set, or {"expression":null,"pushStatus":null} to remove it`,
          code: 'invalid_property',
        })
        continue
      }

      const p = val as Record<string, unknown>
      const expr = p.expression
      const push = p.pushStatus

      const isRemoval = expr === null && push === null
      const isSet =
        typeof expr === 'string' &&
        expr.trim().length > 0 &&
        typeof push === 'string' &&
        (PUSH_STATUSES as readonly string[]).includes(push)

      if (!isRemoval && !isSet) {
        errors.push({
          field: `${prefix}.propertiesJson`,
          message: `Property "${name}" must set a non-empty "expression" string with "pushStatus" one of ${PUSH_STATUSES.join(
            ', ',
          )}, or remove it with {"expression":null,"pushStatus":null}`,
          code: 'invalid_property',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
