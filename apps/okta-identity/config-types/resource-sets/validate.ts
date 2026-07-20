import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Resource Sets API constraints --------------------------------------
//
// A resource set is a named collection of Okta resources (ORNs or REST URLs).
// Its logical identity is its LABEL. Endpoints:
//   GET  /iam/resource-sets                          — list ({ 'resource-sets': [...] })
//   POST /iam/resource-sets                          — create ({ label, description, resources[] })
//   PUT  /iam/resource-sets/{idOrLabel}              — replace label/description ONLY
//   DEL  /iam/resource-sets/{idOrLabel}              — delete
//   GET/PATCH/DELETE /iam/resource-sets/{id}/resources[/{resourceId}] — manage resources

/** Resource label length cap. */
export const MAX_RESOURCE_SET_LABEL_LENGTH = 255

/** Okta caps a resource set at 1000 resources. */
export const MAX_RESOURCES_PER_SET = 1000

/**
 * Plausible resource-reference shape: an ORN (orn:okta:...) or an https REST URL.
 * Used only for a soft WARNING — Okta owns the authoritative resource model and
 * rejects an invalid reference at deploy time.
 */
export const RESOURCE_REFERENCE_PATTERN = /^(orn:okta:[a-z0-9-]+:.+|https:\/\/.+)$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ResourceSetSpec {
  sectionName: string
  /** Resource set label — the logical identity deploy matches on. */
  label: string
  /** Resource set description (required by Okta). */
  description: string
  /** De-duplicated resource references (ORN or REST URL). */
  resources: string[]
}

/** Shape of a resource set returned by GET /iam/resource-sets and /{id}. */
export interface LiveResourceSet {
  id?: string
  label?: string
  description?: string
  created?: string
  lastUpdated?: string
  _links?: unknown
  [key: string]: unknown
}

/**
 * Shape of a resource membership returned by GET /iam/resource-sets/{id}/resources.
 * `id` is the MEMBERSHIP object's id (the value passed to DELETE .../resources/{id}),
 * NOT the target resource's id. `orn` is the normalized target reference; the REST
 * URL form is under `_links.self.href`.
 */
export interface LiveResourceMembership {
  /** Membership object id — the DELETE key. */
  id?: string
  /** Normalized ORN of the target resource. */
  orn?: string
  _links?: { self?: { href?: string } }
  [key: string]: unknown
}

/** Split a canvas `tags` value (array) or comma/newline string into trimmed items. */
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

/** Each canvas item describes one Okta resource set. */
export function extractResourceSetSpecs(canvas: CanvasSnapshot): ResourceSetSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      label: typeof fields.label === 'string' ? fields.label.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      // De-dupe the resource set so reconciliation math is stable.
      resources: [...new Set(splitList(fields.resources))],
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate resource-set configurations against the Okta Roles API. Static only —
 * it never contacts Okta:
 *   - label is required, <= 255 chars, unique within the canvas
 *   - description is required
 *   - at least one resource is required, at most 1000; each is flagged (WARNING)
 *     if it does not look like an ORN or an https REST URL
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractResourceSetSpecs(ctx.canvas)
  const seenLabels = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // label — required, <= 255 chars, unique
    if (!spec.label) {
      errors.push({ field: `${prefix}.label`, message: 'Resource set label is required', code: 'required' })
    } else {
      if (spec.label.length > MAX_RESOURCE_SET_LABEL_LENGTH) {
        errors.push({
          field: `${prefix}.label`,
          message: `Resource set label must be ${MAX_RESOURCE_SET_LABEL_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.label.toLowerCase()
      if (seenLabels.has(key)) {
        errors.push({
          field: `${prefix}.label`,
          message: `Duplicate resource set "${spec.label}" — each label may only be declared once per canvas`,
          code: 'duplicate_label',
        })
      }
      seenLabels.add(key)
    }

    // description — required by Okta
    if (!spec.description) {
      errors.push({
        field: `${prefix}.description`,
        message: 'Resource set description is required',
        code: 'required',
      })
    }

    // resources — at least one, at most 1000; each flagged (warning) if shape looks off
    if (spec.resources.length === 0) {
      errors.push({
        field: `${prefix}.resources`,
        message: 'Add at least one resource (an ORN or a REST URL), e.g. orn:okta:directory:00o...:groups',
        code: 'required',
      })
    } else {
      if (spec.resources.length > MAX_RESOURCES_PER_SET) {
        errors.push({
          field: `${prefix}.resources`,
          message: `A resource set may contain at most ${MAX_RESOURCES_PER_SET} resources`,
          code: 'too_many_resources',
        })
      }
      for (const ref of spec.resources) {
        if (!RESOURCE_REFERENCE_PATTERN.test(ref)) {
          warnings.push({
            field: `${prefix}.resources`,
            message: `"${ref}" does not look like an ORN or an https REST URL — Okta will reject an invalid resource reference at deploy time`,
            code: 'suspicious_resource',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
