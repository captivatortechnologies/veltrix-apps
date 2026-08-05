import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ReportConfigSpec {
  sectionName: string
  name: string
  templateId: string
  format: string
  /** Site names in scope, one per line — resolved to ids at deploy time. */
  siteNames: string[]
  /** Asset group names in scope, one per line — resolved to ids at deploy time. */
  assetGroupNames: string[]
  /** Tag names in scope, one per line — resolved to ids at deploy time. */
  tagNames: string[]
  /** Extra report config (frequency, email, storage, baseline, filters, …) as JSON. */
  reportConfigJson: string
}

/**
 * Shape of a report configuration returned by GET /reports. The index signature
 * preserves every other field (frequency, email, storage, baseline, filters,
 * scope, …) so rollback can PUT the prior document back verbatim.
 */
export interface LiveReportConfig {
  id?: number
  name?: string
  format?: string
  template?: string
  scope?: {
    sites?: number[]
    assetGroups?: number[]
    tags?: number[]
    assets?: number[]
    scan?: number
  }
  [key: string]: unknown
}

/** The name natural key — a report configuration's logical identity. */
export function reportConfigKey(spec: { name: string }): string {
  return spec.name.trim().toLowerCase()
}

/**
 * Parse a JSON object field. NON-UNION { value, error } (never a discriminated
 * union — the platform loader can't narrow those).
 */
export interface JsonParseResult {
  value: Record<string, unknown> | null
  error: string | null
}

export function parseJsonObject(raw: string | undefined): JsonParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** Split a newline-delimited textarea into a trimmed, de-blanked list of names. */
export function parseNames(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one InsightVM report configuration. */
export function extractReportConfigSpecs(canvas: CanvasSnapshot): ReportConfigSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      templateId: str(fields.template_id),
      format: str(fields.format),
      siteNames: parseNames(typeof fields.site_names === 'string' ? fields.site_names : ''),
      assetGroupNames: parseNames(typeof fields.asset_group_names === 'string' ? fields.asset_group_names : ''),
      tagNames: parseNames(typeof fields.tag_names === 'string' ? fields.tag_names : ''),
      reportConfigJson: typeof fields.report_config_json === 'string' ? fields.report_config_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate report-configuration entries: a name, template id and format are
 * required, the extra config JSON (when present) must parse to an object, and
 * the name (the natural key) is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractReportConfigSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Report name is required', code: 'required' })
    }
    if (!spec.templateId) {
      errors.push({ field: `${prefix}.template_id`, message: 'Report template id is required', code: 'required' })
    }
    if (!spec.format) {
      errors.push({ field: `${prefix}.format`, message: 'Report format is required', code: 'required' })
    }

    if (spec.reportConfigJson.trim()) {
      const parsed = parseJsonObject(spec.reportConfigJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.report_config_json`, message: `Report config ${parsed.error}`, code: 'invalid_json' })
      }
    }

    if (
      spec.siteNames.length === 0 &&
      spec.assetGroupNames.length === 0 &&
      spec.tagNames.length === 0
    ) {
      warnings.push({
        field: `${prefix}.site_names`,
        message: 'No scope declared — the console defaults an unscoped report to every site the owner can access',
        code: 'unscoped_report',
      })
    }

    if (spec.name) {
      const key = reportConfigKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate report "${spec.name}" — each report name may only be declared once`,
          code: 'duplicate_report',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
