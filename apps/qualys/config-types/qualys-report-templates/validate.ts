import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Supported VM Report Template types. Each is create/update/delete/export on
 * its own classic v2 endpoint (`/api/2.0/fo/report/template/<path>/`); the
 * wrapper tag is the root element Export returns and Create/Update expect
 * (`<REPORTTEMPLATE><wrapperTag>…`); `listTemplateType` is this type's value in
 * the shared `/msp/report_template_list.php` metadata list's `<TEMPLATE_TYPE>`.
 *
 * PCI Scan Template is intentionally NOT included — see README Coverage: its
 * `TEMPLATE_TYPE` value in that shared metadata list is not documented
 * distinctly from Scan/Compliance in the available API guide samples, so it
 * cannot be safely reconciled by title without risking a collision.
 */
export const REPORT_TEMPLATE_TYPES = [
  { value: 'scan', label: 'Scan Report Template', path: 'scan', wrapperTag: 'SCANTEMPLATE', listTemplateType: 'Scan' },
  { value: 'patch', label: 'Patch Report Template', path: 'patch', wrapperTag: 'PATCHTEMPLATE', listTemplateType: 'Patch' },
  { value: 'map', label: 'Map Report Template', path: 'map', wrapperTag: 'MAPTEMPLATE', listTemplateType: 'Map' },
] as const

export type ReportTemplateType = (typeof REPORT_TEMPLATE_TYPES)[number]['value']

/** Metadata for a report template type, or undefined if unsupported. */
export function reportTemplateTypeMeta(templateType: string) {
  return REPORT_TEMPLATE_TYPES.find((t) => t.value === templateType)
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ReportTemplateSpec {
  sectionName: string
  templateType: string
  title: string
  owner: string
  settingsXml: string
}

/** Shape of a report template resolved from `/msp/report_template_list.php` (metadata only). */
export interface LiveReportTemplate {
  id: string
  title: string
}

/** The (template type, title) natural key — templates are namespaced per report type. */
export function reportTemplateKey(spec: { templateType: string; title: string }): string {
  return `${spec.templateType.trim().toLowerCase()}::${spec.title.trim().toLowerCase()}`
}

/** Each canvas item describes one Qualys VM report template. */
export function extractReportTemplateSpecs(canvas: CanvasSnapshot): ReportTemplateSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      templateType: typeof fields.template_type === 'string' ? fields.template_type.trim() : '',
      title: typeof fields.title === 'string' ? fields.title.trim() : '',
      owner: typeof fields.owner === 'string' ? fields.owner.trim() : '',
      settingsXml: typeof fields.settings_xml === 'string' ? fields.settings_xml : '',
    }
  })
}

/**
 * A lightweight well-formedness check for an XML fragment — a matching-tag
 * stack walk, NOT a full XML parser (this app deliberately uses regex-based XML
 * helpers throughout, see lib/qualys.ts). CDATA sections are stripped first so
 * angle brackets inside a value (e.g. `asset_groups` text) never get
 * misinterpreted as tags. Empty input is well-formed (the settings are optional
 * — Qualys defaults the rest of the template).
 */
export function isWellFormedXmlFragment(fragment: string): boolean {
  const withoutCdata = fragment.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  if (!withoutCdata.trim()) return true

  const tagPattern = /<\/?([A-Za-z_][\w.-]*)(?:\s[^>]*)?\/?>/g
  const stack: string[] = []
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(withoutCdata))) {
    const full = match[0]
    const name = match[1]
    if (full.startsWith('</')) {
      if (stack.length === 0 || stack[stack.length - 1] !== name) return false
      stack.pop()
    } else if (!full.endsWith('/>')) {
      stack.push(name)
    }
  }
  return stack.length === 0
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate report template configurations: a supported template type and a
 * unique (per-type) title are required; the optional settings XML fragment
 * (everything the Create/Update body carries besides the title/owner this app
 * manages) must be well-formed.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractReportTemplateSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.templateType) {
      errors.push({ field: `${prefix}.template_type`, message: 'Template type is required', code: 'required' })
    } else if (!reportTemplateTypeMeta(spec.templateType)) {
      errors.push({
        field: `${prefix}.template_type`,
        message: `Unsupported report template type "${spec.templateType}"`,
        code: 'invalid_value',
      })
    }

    if (!spec.title) {
      errors.push({ field: `${prefix}.title`, message: 'Report template title is required', code: 'required' })
    }

    if (!isWellFormedXmlFragment(spec.settingsXml)) {
      errors.push({
        field: `${prefix}.settings_xml`,
        message: 'Settings must be well-formed XML (matching open/close tags)',
        code: 'invalid_xml',
      })
    }

    if (spec.templateType && spec.title) {
      const key = reportTemplateKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.title`,
          message: `Duplicate ${spec.templateType} report template "${spec.title}" — each (type, title) pair may only be declared once`,
          code: 'duplicate_report_template',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
