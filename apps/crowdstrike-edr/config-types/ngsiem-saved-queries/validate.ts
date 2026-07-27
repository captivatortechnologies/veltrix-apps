import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'
import type { LiveEntity } from '../../lib/entityAdapter'

// --- NG-SIEM Saved Query constraints -----------------------------------------

const NAME_MAX_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SavedQuerySpec {
  sectionName: string
  /** Identity in Falcon — the saved query name. */
  name: string
  description?: string
  /** CrowdStrike Query Language (CQL) search expression. */
  query: string
  /** Free-form time range, e.g. a relative window ("24h") or a start/end string. */
  timeRange?: string
  /** Whether the saved query is shared with the tenant (vs. private). */
  shared: boolean
}

/**
 * Shape of a saved query returned by
 * GET /ngsiem-content/entities/savedqueries-template/v1?ids=…
 *
 * UNVERIFIED field names — the NG-SIEM content template APIs are new and the
 * template representation is not fully documented. `query`/`time_range`/`shared`
 * are the best-guess names; drift compares defensively and treats anything
 * missing as "not set" so an unexpected shape degrades gracefully rather than
 * reporting false drift on every field.
 */
export interface LiveSavedQuery extends LiveEntity {
  query?: string
  time_range?: string
  shared?: boolean
  is_shared?: boolean
  /** Last-modifier fields (names unverified) — bridged for drift attribution. */
  updated_by?: string
  updated_at?: string
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function optional(value: unknown): string | undefined {
  const v = trimmed(value)
  return v.length > 0 ? v : undefined
}

/** Each canvas section describes one saved query. */
export function extractSavedQuerySpecs(canvas: CanvasSnapshot): SavedQuerySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: trimmed(fields.name),
      description: optional(fields.description),
      query: trimmed(fields.query),
      timeRange: optional(fields.timeRange),
      shared: coerceBoolean(fields.shared, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate saved query configurations: a non-empty name (unique per canvas) and
 * a non-empty CQL query. The CQL itself is not parsed here — Falcon is the
 * authority on query syntax and rejects an invalid query at deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSavedQuerySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Saved query name is required', code: 'required' })
    } else {
      if (spec.name.length > NAME_MAX_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Saved query name must be ${NAME_MAX_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate saved query "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    // query (CQL)
    if (!spec.query) {
      errors.push({ field: `${prefix}.query`, message: 'CQL query is required', code: 'required' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
