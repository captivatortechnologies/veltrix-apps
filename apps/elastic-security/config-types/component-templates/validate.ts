import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Elasticsearch _component_template API constraints -----------------------

/** Template name length cap (kept generous; ES itself is lenient here). */
export const MAX_TEMPLATE_NAME_LENGTH = 255

/**
 * Elastic's own built-in component templates, shipped for the logs / metrics /
 * synthetics data-stream conventions. A config MUST NOT author one of these.
 */
export const RESERVED_TEMPLATE_NAMES = [
  'logs-mappings',
  'logs-settings',
  'metrics-mappings',
  'metrics-settings',
  'synthetics-mapping',
  'synthetics-settings',
] as const

/** Names beginning with `.` or `@` are the Elastic-managed / internal convention. */
export function isReservedTemplateName(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.startsWith('@') ||
    RESERVED_TEMPLATE_NAMES.includes(name as (typeof RESERVED_TEMPLATE_NAMES)[number])
  )
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ComponentTemplateSpec {
  sectionName: string
  /** Template name — the logical identity carried in the PUT/GET/DELETE path. */
  name: string
  version?: number
  deprecated: boolean
  /** Raw JSON-object string: the value of the "template" key. Required. */
  templateJson?: string
  /** Raw JSON-object string of arbitrary metadata (the template's `_meta`). */
  metaJson?: string
}

/** The "template" object inside a component template — the part this app authors/diffs. */
export interface LiveComponentTemplateBody {
  mappings?: Record<string, unknown>
  settings?: Record<string, unknown>
  aliases?: Record<string, unknown>
  lifecycle?: Record<string, unknown>
}

/** One entry of GET /_component_template[/{name}] → `{ component_templates: [{ name, component_template: {...} }] }`. */
export interface LiveComponentTemplateEntry {
  name: string
  component_template: {
    template?: LiveComponentTemplateBody
    version?: number
    _meta?: Record<string, unknown>
    deprecated?: boolean
  }
}

/** The GET /_component_template response envelope. */
export interface LiveComponentTemplateResponse {
  component_templates?: LiveComponentTemplateEntry[]
}

/** Parse a raw JSON string, returning the object or null when it is not a JSON object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
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

/** True when a live template is flagged Elastic-managed via `_meta.managed: true`. */
export function isManagedTemplate(entry: LiveComponentTemplateEntry): boolean {
  const meta = entry.component_template?._meta
  return !!meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as Record<string, unknown>).managed === true
}

/** Each canvas section describes one component template. */
export function extractTemplateSpecs(canvas: CanvasSnapshot): ComponentTemplateSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const trimmed = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim() ? (fields[key] as string).trim() : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      version: typeof fields.version === 'number' ? fields.version : undefined,
      deprecated: fields.deprecated === true,
      templateJson: trimmed('templateJson'),
      metaJson: trimmed('metaJson'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate component-template configurations against Elasticsearch
 * _component_template constraints. Static rules only — NO network:
 *   - name is required, capped, and must NOT be a reserved / built-in name
 *   - templateJson is required and must parse to a JSON object; a WARNING
 *     nudges toward including at least one of mappings/settings/aliases
 *   - metaJson, when present, must parse to a JSON object
 *   - the name — a template's logical identity — must be unique across the canvas
 *
 * The live-managed backstop (refusing any live template with `_meta.managed:
 * true`) is enforced in deploy, where the current server state is available.
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
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Template name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_TEMPLATE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Template name must be ${MAX_TEMPLATE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (isReservedTemplateName(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Template name "${spec.name}" is reserved — names starting with "." or "@", and Elastic's built-in logs-*/metrics-*/synthetics-* templates, cannot be authored`,
          code: 'protected_template',
        })
      }
    }

    if (!spec.templateJson) {
      errors.push({
        field: `${prefix}.templateJson`,
        message: 'Template is required — provide the template object, e.g. {"settings":{...},"mappings":{...}}',
        code: 'required',
      })
    } else {
      const parsed = parseJsonObject(spec.templateJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.templateJson`,
          message: 'Template must be a valid JSON object, e.g. {"mappings":{"properties":{...}}}',
          code: 'invalid_template',
        })
      } else if (!('mappings' in parsed) && !('settings' in parsed) && !('aliases' in parsed)) {
        warnings.push({
          field: `${prefix}.templateJson`,
          message: 'Template defines none of mappings/settings/aliases — a usable component template normally sets at least one',
          code: 'empty_template',
        })
      }
    }

    if (spec.metaJson && parseJsonObject(spec.metaJson) === null) {
      errors.push({
        field: `${prefix}.metaJson`,
        message: 'Meta must be a valid JSON object, e.g. {"managed_by":"veltrix"} — leave blank for none',
        code: 'invalid_meta',
      })
    }

    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate template "${spec.name}" — each template name may only be declared once per canvas`,
          code: 'duplicate_template',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
