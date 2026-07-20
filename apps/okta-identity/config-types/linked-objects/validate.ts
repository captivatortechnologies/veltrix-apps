import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Linked Objects API constraints -------------------------------------
//
// A user linked-object definition links two relationship names — a primary side
// and its associated (inverse) side — through the Linked Objects API:
//   GET    /api/v1/meta/schemas/user/linkedObjects                     — list all
//   POST   /api/v1/meta/schemas/user/linkedObjects                     — create (409 if it exists)
//   GET    /api/v1/meta/schemas/user/linkedObjects/{linkedObjectName}  — retrieve
//   DELETE /api/v1/meta/schemas/user/linkedObjects/{linkedObjectName}  — delete the WHOLE definition
// There is NO update (no PUT/PATCH): a definition is IMMUTABLE. To change one you
// delete it (removing every user link that uses it) and recreate it. Each side's
// `type` is always "USER".

/** Both sides of a linked object are always user relationships. */
export const LINKED_OBJECT_TYPE = 'USER'

/**
 * A relationship name accepts only letters, digits and underscores, and may NOT
 * start with a digit (Okta: /^[a-zA-Z_][a-zA-Z0-9_]*$/).
 */
export const LINKED_OBJECT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface LinkedObjectSpec {
  sectionName: string
  /** API name of the primary side — the logical identity deploy matches on. */
  primaryName: string
  /** Display name of the primary side. */
  primaryTitle: string
  /** Optional description of the primary side. */
  primaryDescription?: string
  /** API name of the associated (inverse) side. */
  associatedName: string
  /** Display name of the associated side. */
  associatedTitle: string
  /** Optional description of the associated side. */
  associatedDescription?: string
}

/** One side of a linked-object definition as returned by the API. */
interface LinkedObjectSide {
  name?: string
  title?: string
  type?: string
  description?: string
  [key: string]: unknown
}

/**
 * Shape of a linked-object definition returned by GET
 * /meta/schemas/user/linkedObjects. Carries an index signature so a live
 * definition can be handed to helpers typed as `Record<string, unknown>`.
 */
export interface LiveLinkedObject {
  primary?: LinkedObjectSide
  associated?: LinkedObjectSide
  _links?: unknown
  [key: string]: unknown
}

/** Trim a canvas string field, returning '' for a non-string value. */
function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Trim a canvas string field, returning undefined when it is blank. */
function optionalString(value: unknown): string | undefined {
  const trimmed = trimString(value)
  return trimmed ? trimmed : undefined
}

/** Each canvas item describes one Okta user linked-object definition. */
export function extractLinkedObjectSpecs(canvas: CanvasSnapshot): LinkedObjectSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      primaryName: trimString(fields.primaryName),
      primaryTitle: trimString(fields.primaryTitle),
      primaryDescription: optionalString(fields.primaryDescription),
      associatedName: trimString(fields.associatedName),
      associatedTitle: trimString(fields.associatedTitle),
      associatedDescription: optionalString(fields.associatedDescription),
    }
  })
}

/**
 * Build the create (POST) body for a linked-object definition. Both sides are
 * always type "USER"; a description is included only when the operator set one.
 */
export function buildLinkedObjectBody(spec: LinkedObjectSpec): {
  primary: Record<string, unknown>
  associated: Record<string, unknown>
} {
  const primary: Record<string, unknown> = {
    name: spec.primaryName,
    title: spec.primaryTitle,
    type: LINKED_OBJECT_TYPE,
  }
  if (spec.primaryDescription !== undefined) primary.description = spec.primaryDescription

  const associated: Record<string, unknown> = {
    name: spec.associatedName,
    title: spec.associatedTitle,
    type: LINKED_OBJECT_TYPE,
  }
  if (spec.associatedDescription !== undefined) associated.description = spec.associatedDescription

  return { primary, associated }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate linked-object definitions against the Okta Linked Objects API. Static
 * only — it never contacts Okta:
 *   - primaryName and associatedName are required and match the Okta name pattern
 *     (letters/digits/underscore, and may not start with a digit)
 *   - primaryTitle and associatedTitle are required
 *   - primaryName and associatedName differ (a definition links two distinct names)
 *   - primaryName is unique within the canvas (case-insensitive)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLinkedObjectSpecs(ctx.canvas)
  const seenPrimaryNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // primaryName — required and matching the Okta name pattern.
    if (!spec.primaryName) {
      errors.push({ field: `${prefix}.primaryName`, message: 'Primary name is required', code: 'required' })
    } else if (!LINKED_OBJECT_NAME_PATTERN.test(spec.primaryName)) {
      errors.push({
        field: `${prefix}.primaryName`,
        message: `Primary name "${spec.primaryName}" is invalid — use only letters, digits and underscores, and it may not start with a digit`,
        code: 'invalid_name',
      })
    }

    // associatedName — required and matching the Okta name pattern.
    if (!spec.associatedName) {
      errors.push({ field: `${prefix}.associatedName`, message: 'Associated name is required', code: 'required' })
    } else if (!LINKED_OBJECT_NAME_PATTERN.test(spec.associatedName)) {
      errors.push({
        field: `${prefix}.associatedName`,
        message: `Associated name "${spec.associatedName}" is invalid — use only letters, digits and underscores, and it may not start with a digit`,
        code: 'invalid_name',
      })
    }

    // titles — both required.
    if (!spec.primaryTitle) {
      errors.push({ field: `${prefix}.primaryTitle`, message: 'Primary title is required', code: 'required' })
    }
    if (!spec.associatedTitle) {
      errors.push({ field: `${prefix}.associatedTitle`, message: 'Associated title is required', code: 'required' })
    }

    // primary and associated names must be two distinct relationship names.
    if (spec.primaryName && spec.associatedName && spec.primaryName === spec.associatedName) {
      errors.push({
        field: `${prefix}.associatedName`,
        message:
          'Primary and associated names must differ — a definition links two distinct relationship names',
        code: 'same_name',
      })
    }

    // primaryName — unique within the canvas (case-insensitive), since it is the
    // logical identity deploy matches on.
    if (spec.primaryName) {
      const key = spec.primaryName.toLowerCase()
      if (seenPrimaryNames.has(key)) {
        errors.push({
          field: `${prefix}.primaryName`,
          message: `Duplicate primary name "${spec.primaryName}" — each definition may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenPrimaryNames.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
