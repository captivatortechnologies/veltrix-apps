import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface HostConfigRuleSpec {
  sectionName: string
  name: string
  description: string
  enabled: boolean
  targetPlatformIds: string[]
  directOval: string
  securitySubCategories: string[]
}

/** A rule as returned by the `hostConfigurationRules` list query. */
export interface LiveHostConfigRule {
  id?: string
  name?: string
  enabled?: boolean | null
  builtin?: boolean | null
}

/** A rule as returned by the single-rule read query (full managed state). */
export interface FullHostConfigRule {
  id?: string
  name?: string
  description?: string
  directOVAL?: string
  enabled?: boolean | null
  targetPlatforms?: Array<{ id?: string }>
  securitySubCategories?: Array<{ id?: string }>
  builtin?: boolean | null
}

/** The rule's logical identity: its name (case-insensitive, trimmed). */
export function ruleKey(name: string): string {
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

/** Each canvas item describes one Wiz host configuration rule. */
export function extractHostConfigRuleSpecs(canvas: CanvasSnapshot): HostConfigRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      enabled: readBool(fields.enabled, true),
      targetPlatformIds: strList(fields.target_platform_ids),
      directOval: typeof fields.direct_oval === 'string' ? fields.direct_oval.trim() : '',
      securitySubCategories: strList(fields.security_sub_categories),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz host-configuration-rule configurations: name is required and
 * unique across the canvas (case-insensitive); at least one target platform id
 * and an OVAL definition are required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractHostConfigRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    }
    if (spec.targetPlatformIds.length === 0) {
      errors.push({
        field: `${prefix}.target_platform_ids`,
        message: 'At least one target platform id is required',
        code: 'required',
      })
    }
    if (!spec.directOval) {
      errors.push({ field: `${prefix}.direct_oval`, message: 'An OVAL definition is required', code: 'required' })
    }

    if (spec.name) {
      const key = ruleKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" — each rule name may only be declared once`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
