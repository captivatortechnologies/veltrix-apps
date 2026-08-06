import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Kandji Library "Custom Scripts" — https://api-docs.iru.com:
//   GET    /api/v1/library/custom-scripts           — list (page param)
//   GET    /api/v1/library/custom-scripts/{id}      — get
//   POST   /api/v1/library/custom-scripts           — create (Body: raw JSON)
//   PATCH  /api/v1/library/custom-scripts/{id}      — update (Body: raw JSON)
//   DELETE /api/v1/library/custom-scripts/{id}      — delete

export const EXECUTION_FREQUENCIES = ['once', 'every_15_min', 'every_day', 'no_enforcement'] as const
export type ExecutionFrequency = (typeof EXECUTION_FREQUENCIES)[number]

export interface CustomScriptSpec {
  sectionName: string
  name: string
  executionFrequency: string
  active: boolean
  restart: boolean
  script: string
  remediationScript: string
  showInSelfService: boolean
  selfServiceCategoryId: string
  selfServiceRecommended: boolean
}

/** Shape of a Kandji Custom Script Library item, as returned by list/get/create/update. */
export interface LiveCustomScript {
  id?: string
  name?: string
  active?: boolean
  execution_frequency?: string
  restart?: boolean
  script?: string
  remediation_script?: string
  show_in_self_service?: boolean
  self_service_category_id?: string | null
  self_service_recommended?: boolean
}

export function customScriptKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexCustomScriptsByName(items: LiveCustomScript[]): Map<string, LiveCustomScript> {
  const byName = new Map<string, LiveCustomScript>()
  for (const item of items) {
    if (!item.name) continue
    const key = customScriptKey(item.name)
    if (!byName.has(key)) byName.set(key, item)
  }
  return byName
}

export function extractCustomScriptSpecs(canvas: CanvasSnapshot): CustomScriptSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const bool = (value: unknown, fallback: boolean): boolean =>
      typeof value === 'boolean' ? value : fallback
    return {
      sectionName: section.name,
      name: str(fields.name),
      executionFrequency: str(fields.execution_frequency) || 'no_enforcement',
      active: bool(fields.active, true),
      restart: bool(fields.restart, false),
      script: typeof fields.script === 'string' ? fields.script : '',
      remediationScript: typeof fields.remediation_script === 'string' ? fields.remediation_script : '',
      showInSelfService: bool(fields.show_in_self_service, false),
      selfServiceCategoryId: str(fields.self_service_category_id),
      selfServiceRecommended: bool(fields.self_service_recommended, false),
    }
  })
}

/** The JSON body POST/PATCH /api/v1/library/custom-scripts accepts for a spec. */
export function buildCustomScriptBody(spec: CustomScriptSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    execution_frequency: spec.executionFrequency,
    script: spec.script,
    active: spec.active,
    restart: spec.restart,
    show_in_self_service: spec.showInSelfService,
  }
  if (spec.remediationScript) body.remediation_script = spec.remediationScript
  if (spec.showInSelfService && spec.selfServiceCategoryId) {
    body.self_service_category_id = spec.selfServiceCategoryId
    body.self_service_recommended = spec.selfServiceRecommended
  }
  return body
}

/**
 * Validate Custom Script configurations: name and script body are required,
 * execution_frequency must be a supported value, self_service_category_id is
 * required when Self Service is enabled (Kandji's own API rejects
 * show_in_self_service=true without one), and names are unique across the
 * canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCustomScriptSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Custom Script name is required', code: 'required' })
    }
    if (!spec.script) {
      errors.push({ field: `${prefix}.script`, message: 'A script body is required', code: 'required' })
    }
    if (!EXECUTION_FREQUENCIES.includes(spec.executionFrequency as ExecutionFrequency)) {
      errors.push({
        field: `${prefix}.execution_frequency`,
        message: `Execution frequency must be one of ${EXECUTION_FREQUENCIES.join(', ')} (got "${spec.executionFrequency}")`,
        code: 'invalid_execution_frequency',
      })
    }
    if (spec.showInSelfService && !spec.selfServiceCategoryId) {
      errors.push({
        field: `${prefix}.self_service_category_id`,
        message: 'A Self Service Category ID is required when Show in Self Service is enabled',
        code: 'required',
      })
    }
    if (!spec.showInSelfService && spec.selfServiceCategoryId) {
      warnings.push({
        field: `${prefix}.self_service_category_id`,
        message: 'Self Service Category ID is set but Show in Self Service is disabled — it will be ignored',
        code: 'ignored_field',
      })
    }

    if (spec.name) {
      const key = customScriptKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Custom Script "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_custom_script',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
