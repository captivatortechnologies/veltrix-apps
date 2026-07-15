import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Policies API constraints -------------------------------------------------

/** A scan policy name is capped at 255 characters. */
export const MAX_POLICY_NAME_LENGTH = 255

/**
 * An editor POLICY template UUID from GET /editor/policy/templates. Like scan
 * template uuids, Tenable's editor template uuids extend the standard 8-4-4-4-12
 * layout with extra hex in the final group, so the trailing group is length
 * 12-or-more rather than exactly 12.
 */
export const TEMPLATE_UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12,}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface PolicySpec {
  sectionName: string
  /** Policy name — the logical identity used to match live policies. */
  name: string
  description?: string
  /** Editor POLICY template uuid (top-level `uuid` in the create/update body). */
  templateUuid: string
  /** Raw JSON-object string of advanced settings merged into `settings`; absent/blank = template defaults. */
  settingsJson?: string
}

/**
 * Shape of a scan policy across the Policies API. GET /policies (list) returns
 * `{ id, name, template_uuid }`; GET /policies/{id} (detail) returns the editor
 * object with the template uuid at top level (`uuid`) and `settings` holding the
 * name/description. Fields are optional because the two endpoints surface
 * different subsets.
 */
export interface LivePolicy {
  id?: number
  name?: string
  template_uuid?: string
  /** Detail-only: the editor policy template uuid (top-level on GET /policies/{id}). */
  uuid?: string
  settings?: {
    name?: string
    description?: string
    [key: string]: unknown
  }
}

/**
 * Parse a raw advanced-settings string, returning the object or null when the
 * string is not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to merge into `settings`).
 */
export function parseSettingsObject(raw: string): Record<string, unknown> | null {
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

/** Each canvas item describes one Tenable scan policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const templateUuid =
      typeof fields.templateUuid === 'string' ? fields.templateUuid.trim() : ''
    const settingsJson =
      typeof fields.settingsJson === 'string' && fields.settingsJson.trim()
        ? fields.settingsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      templateUuid,
      settingsJson,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scan-policy configurations against Policies API constraints: a name
 * is required (<= 255 chars, unique within the canvas), the editor policy
 * template uuid is required and uuid-shaped, and any advanced settingsJson must
 * parse as a JSON object. Static only — no network (the template uuid's
 * existence is a runtime concern for the Tenable tenant, not a validate check).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_POLICY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name must be ${MAX_POLICY_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      // Name is the logical identity deploy matches on — a duplicate would make
      // create-vs-update ambiguous, so reject it up front.
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // templateUuid — required; loose uuid-ish shape check
    if (!spec.templateUuid) {
      errors.push({
        field: `${prefix}.templateUuid`,
        message: 'Policy template UUID is required (from GET /editor/policy/templates)',
        code: 'required',
      })
    } else if (!TEMPLATE_UUID_PATTERN.test(spec.templateUuid)) {
      errors.push({
        field: `${prefix}.templateUuid`,
        message: 'Policy template UUID is malformed — copy it from GET /editor/policy/templates',
        code: 'invalid_uuid',
      })
    }

    // settingsJson — optional; when present it must parse as a JSON object
    if (spec.settingsJson && parseSettingsObject(spec.settingsJson) === null) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message:
          'Advanced settings must be a valid JSON object, e.g. {"acls":[…]} — leave blank for template defaults',
        code: 'invalid_settings',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
