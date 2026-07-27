import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'
import type { LiveEntity } from '../../lib/entityAdapter'

// --- NG-SIEM Dashboard constraints -------------------------------------------

const NAME_MAX_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DashboardSpec {
  sectionName: string
  /** Identity in Falcon — the dashboard name. */
  name: string
  description?: string
  /** Raw widget/layout definition JSON text as entered. */
  definitionRaw: string
  /** Whether the dashboard is shared with the tenant (vs. private). */
  shared: boolean
}

/**
 * Shape of a dashboard returned by
 * GET /ngsiem-content/entities/dashboards-template/v1?ids=…
 *
 * UNVERIFIED field names — the NG-SIEM content template APIs are new and the
 * template representation is not fully documented. `definition`/`shared` are
 * the best-guess names; drift compares defensively so an unexpected shape
 * degrades gracefully rather than reporting false drift on every field.
 */
export interface LiveDashboard extends LiveEntity {
  /** The widget/layout definition — an object with per-widget CQL queries. */
  definition?: unknown
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

/** Each canvas section describes one dashboard. */
export function extractDashboardSpecs(canvas: CanvasSnapshot): DashboardSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: trimmed(fields.name),
      description: optional(fields.description),
      definitionRaw: trimmed(fields.definition),
      shared: coerceBoolean(fields.shared, false),
    }
  })
}

// --- Definition JSON parsing --------------------------------------------------

export interface DefinitionResult {
  /** The parsed definition object, or undefined when raw is empty/unparseable. */
  value?: Record<string, unknown>
  /** Set when definitionRaw is non-empty but does not parse to a JSON object. */
  error?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the dashboard definition JSON. The definition is a widget/layout object
 * (with per-widget CQL queries); only that it is a JSON object is enforced here
 * — Falcon is the authority on the internal widget schema and rejects an
 * invalid definition at deploy time.
 */
export function parseDefinition(raw: string): DefinitionResult {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: 'Definition must be valid JSON' }
  }
  if (!isPlainObject(parsed)) {
    return {
      error: 'Definition must be a JSON object, e.g. {"widgets": [ ... ], "layout": { ... }}',
    }
  }
  return { value: parsed }
}

/**
 * Stable string form of a JSON value: object keys are sorted recursively while
 * array order is preserved (widget/layout order is significant). Used to
 * compare the deployed definition against the live one without false drift from
 * key reordering.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key])
    }
    return out
  }
  return value
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate dashboard configurations: a non-empty name (unique per canvas) and a
 * definition that parses to a JSON object.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDashboardSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Dashboard name is required', code: 'required' })
    } else {
      if (spec.name.length > NAME_MAX_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Dashboard name must be ${NAME_MAX_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate dashboard "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    // definition (widget/layout JSON)
    if (!spec.definitionRaw) {
      errors.push({ field: `${prefix}.definition`, message: 'Dashboard definition is required', code: 'required' })
    } else {
      const def = parseDefinition(spec.definitionRaw)
      if (def.error) {
        errors.push({ field: `${prefix}.definition`, message: def.error, code: 'invalid_definition' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
