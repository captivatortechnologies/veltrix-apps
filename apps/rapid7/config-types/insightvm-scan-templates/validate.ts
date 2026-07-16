import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface TemplateSpec {
  sectionName: string
  templateId: string
  name: string
  description: string
  templateJson: string
}

/**
 * Shape of a scan template returned by GET /scan_templates. The identity is the
 * top-level string `id` (user-settable, e.g. "my-full-audit"). `builtin` marks a
 * console-shipped template that must never be overwritten. The index signature
 * preserves the rest of the template config (checks/policies/discovery) so
 * rollback can PUT the prior document back verbatim.
 */
export interface LiveScanTemplate {
  id?: string
  name?: string
  description?: string
  builtin?: boolean
  [key: string]: unknown
}

/**
 * The scan template's logical identity — its string `id`. Ids are API slugs and
 * are matched case-sensitively (unlike the tag name/type key).
 */
export function templateKey(spec: { templateId: string }): string {
  return spec.templateId
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

/** Each canvas item describes one InsightVM scan template. */
export function extractTemplateSpecs(canvas: CanvasSnapshot): TemplateSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      templateId: typeof fields.template_id === 'string' ? fields.template_id.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      templateJson: typeof fields.template_json === 'string' ? fields.template_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scan template configurations: a template id and name are required, the
 * optional template JSON must parse to an object, and the template id (the
 * template's identity) must be unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTemplateSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.templateId) {
      errors.push({ field: `${prefix}.template_id`, message: 'Template id is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Template name is required', code: 'required' })
    }
    if (spec.templateJson.trim()) {
      const parsed = parseJsonObject(spec.templateJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.template_json`, message: `Template config ${parsed.error}`, code: 'invalid_json' })
      }
    }

    if (spec.templateId) {
      const key = templateKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.template_id`,
          message: `Duplicate scan template id "${spec.templateId}" — each template id may only be declared once`,
          code: 'duplicate_template',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
