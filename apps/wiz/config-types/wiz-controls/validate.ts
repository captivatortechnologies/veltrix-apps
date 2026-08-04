import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Wiz control constraints --------------------------------------------------

export const SEVERITIES = ['INFORMATIONAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

/** Sentinel meaning "all projects" — Wiz's own convention for an unscoped control. */
export const ALL_PROJECTS = '*'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ControlSpec {
  sectionName: string
  name: string
  description: string
  severity: string
  resolutionRecommendation: string
  projectId: string
  /** Raw scope-query JSON as typed by the user (validated separately). */
  scopeQueryText: string
  /** Parsed scope-query value — undefined when blank or malformed. */
  scopeQuery: unknown
  /** Raw query JSON as typed by the user (validated separately). */
  queryText: string
  /** Parsed query value — undefined when blank or malformed. */
  query: unknown
  enabled: boolean
  securitySubCategories: string[]
}

/** A control as returned by the `controls` list query. */
export interface LiveControl {
  id?: string
  name?: string
  severity?: string
  enabled?: boolean | null
}

/** A control as returned by the single-control read query (full managed state). */
export interface FullControl {
  id?: string
  name?: string
  description?: string
  query?: unknown
  scopeQuery?: unknown
  severity?: string
  securitySubCategories?: Array<{ id?: string; title?: string }>
  enabled?: boolean | null
  resolutionRecommendation?: string
  scopeProject?: { id?: string; name?: string } | null
}

/** The control's logical identity: its name (case-insensitive, trimmed). */
export function controlKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Try to parse JSON text; empty text is treated as absent (ok, undefined value). */
export function tryParseJson(text: string): { value: unknown; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    return { value: JSON.parse(trimmed), ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

/** Recursively sort object keys so two structurally-equal JSON values stringify identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]))
  }
  return value
}

/** Structural (key-order-insensitive) equality for two JSON-ish values. */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))
}

/** The declared project id, defaulting to "*" (all projects) when blank. */
export function normalizedProjectId(value: unknown): string {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || ALL_PROJECTS
}

/**
 * Wiz does not reflect a "*" (all projects) scope back on read — `scopeProject`
 * comes back null/empty instead. Treat a live control with no scope project as
 * matching a declared "*", so drift/rollback don't flag Wiz's own read quirk.
 */
export function liveProjectId(scopeProject: { id?: string } | null | undefined): string {
  return scopeProject?.id || ALL_PROJECTS
}

/** Each canvas item describes one Wiz control. */
export function extractControlSpecs(canvas: CanvasSnapshot): ControlSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const scopeQueryText = str(fields.scope_query)
    const queryText = str(fields.query)
    const parsedScopeQuery = tryParseJson(scopeQueryText)
    const parsedQuery = tryParseJson(queryText)
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      severity: str(fields.severity) || 'MEDIUM',
      resolutionRecommendation: str(fields.resolution_recommendation),
      projectId: normalizedProjectId(fields.project_id),
      scopeQueryText,
      scopeQuery: parsedScopeQuery.ok ? parsedScopeQuery.value : undefined,
      queryText,
      query: parsedQuery.ok ? parsedQuery.value : undefined,
      enabled: readBool(fields.enabled, true),
      securitySubCategories: strList(fields.security_sub_categories),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz control configurations: name is required and unique across the
 * canvas (case-insensitive); severity must be a supported value; and both
 * `query` and `scope_query` are required, valid JSON.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractControlSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Control name is required', code: 'required' })
    }
    if (!SEVERITIES.includes(spec.severity as (typeof SEVERITIES)[number])) {
      errors.push({ field: `${prefix}.severity`, message: `Unsupported severity "${spec.severity}"`, code: 'invalid_severity' })
    }

    if (!spec.scopeQueryText) {
      errors.push({ field: `${prefix}.scope_query`, message: 'A scope query is required', code: 'required' })
    } else if (spec.scopeQuery === undefined) {
      errors.push({ field: `${prefix}.scope_query`, message: 'Scope query must be valid JSON', code: 'invalid_json' })
    }

    if (!spec.queryText) {
      errors.push({ field: `${prefix}.query`, message: 'A query is required', code: 'required' })
    } else if (spec.query === undefined) {
      errors.push({ field: `${prefix}.query`, message: 'Query must be valid JSON', code: 'invalid_json' })
    }

    if (spec.name) {
      const key = controlKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate control "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_control',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
