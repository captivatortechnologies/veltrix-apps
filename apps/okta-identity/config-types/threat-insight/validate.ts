import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta ThreatInsight API constraints --------------------------------------
//
// ThreatInsight is an org SINGLETON at /threats/configuration:
//   GET  /threats/configuration   — read the current config
//   POST /threats/configuration   — update (a full replace of action + excludeZones)
// There is no create/delete and no lifecycle. `action` is a lower-case enum.

/** ThreatInsight action values (lower-case, as the API returns/accepts them). */
export const THREAT_INSIGHT_ACTIONS = ['none', 'audit', 'block'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ThreatInsightSpec {
  sectionName: string
  /** none | audit | block — how Okta handles a flagged request. */
  action: string
  /** Network Zone IDs exempt from ThreatInsight evaluation. */
  excludeZones: string[]
}

/** Shape of the config returned by GET /threats/configuration. */
export interface LiveThreatInsight {
  action?: string
  excludeZones?: string[]
  created?: string
  lastUpdated?: string
  _links?: unknown
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

/**
 * Extract the ThreatInsight spec(s) from the canvas. It is a singleton, so a
 * well-formed canvas has exactly one item; all are returned so validate can flag
 * a canvas that mistakenly declares more than one.
 */
export function extractThreatInsightSpecs(canvas: CanvasSnapshot): ThreatInsightSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      // action is a lower-case enum; normalise so an upper-case entry still matches.
      action:
        typeof fields.action === 'string' && fields.action.trim()
          ? fields.action.trim().toLowerCase()
          : '',
      excludeZones: [...new Set(splitList(fields.excludeZones))],
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate the ThreatInsight configuration against the Okta ThreatInsight API.
 * Static only — it never contacts Okta:
 *   - exactly one configuration may be declared (it is an org singleton)
 *   - action is required and one of none | audit | block
 *   - excludeZones (when set) are non-empty strings (Network Zone IDs)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractThreatInsightSpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'sections',
      message: 'ThreatInsight is an org singleton — declare exactly one configuration',
      code: 'singleton',
    })
  }

  for (const spec of specs) {
    const prefix = spec.sectionName

    // action — required and in the enum
    if (!spec.action) {
      errors.push({ field: `${prefix}.action`, message: 'Action is required', code: 'required' })
    } else if (!(THREAT_INSIGHT_ACTIONS as readonly string[]).includes(spec.action)) {
      errors.push({
        field: `${prefix}.action`,
        message: `Action must be one of: ${THREAT_INSIGHT_ACTIONS.join(', ')}`,
        code: 'invalid_action',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
