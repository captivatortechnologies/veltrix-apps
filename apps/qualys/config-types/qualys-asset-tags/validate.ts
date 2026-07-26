import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Tag rule types supported by the Asset Management & Tagging API. STATIC means a
// manually-assigned tag with no automatic rule; every other type evaluates
// ruleText. Values are sent verbatim as the API `ruleType`.
export const TAG_RULE_TYPES = [
  'STATIC',
  'NAME_CONTAINS',
  'NETWORK_RANGE',
  'OS_REGEX',
  'OPEN_PORTS',
  'INSTALLED_SOFTWARE',
  'VULN_EXIST',
  'ASSET_SEARCH',
  'GLOBAL_ASSET_VIEW',
  'CLOUD_ASSET',
  'BUSINESS_INFORMATION',
  'GROOVY',
] as const

export type TagRuleType = (typeof TAG_RULE_TYPES)[number]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AssetTagSpec {
  sectionName: string
  name: string
  ruleType: string
  ruleText: string
  color: string
  criticalityScore: string
}

/** Shape of a tag parsed from a QPS search ServiceResponse Tag object. */
export interface LiveAssetTag {
  id: string
  name: string
  ruleType: string
  ruleText: string
  color: string
  criticalityScore: string
}

/** True when the rule type is dynamic (evaluates ruleText), i.e. not static. */
export function isDynamicRule(ruleType: string): boolean {
  const t = ruleType.trim().toUpperCase()
  return t !== '' && t !== 'STATIC'
}

/** The name natural key — a tag's logical identity (name-keyed collection). */
export function assetTagKey(spec: { name: string }): string {
  return spec.name.trim().toLowerCase()
}

function readNumericField(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return value.trim()
  return ''
}

/** Each canvas item describes one Qualys asset tag. */
export function extractAssetTagSpecs(canvas: CanvasSnapshot): AssetTagSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawType = typeof fields.rule_type === 'string' ? fields.rule_type.trim() : ''
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      ruleType: rawType ? rawType.toUpperCase() : 'STATIC',
      ruleText: typeof fields.rule_text === 'string' ? fields.rule_text.trim() : '',
      color: typeof fields.color === 'string' ? fields.color.trim() : '',
      criticalityScore: readNumericField(fields.criticality_score),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate asset tag configurations: a name is required and unique; the rule type
 * is from the supported set; dynamic rule types require rule text; an optional
 * color must be a 6-digit hex code and an optional criticality score 1–5.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAssetTagSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Tag name is required', code: 'required' })
    }

    if (!TAG_RULE_TYPES.includes(spec.ruleType as TagRuleType)) {
      errors.push({
        field: `${prefix}.rule_type`,
        message: `Unsupported rule type "${spec.ruleType}"`,
        code: 'invalid_value',
      })
    }

    if (isDynamicRule(spec.ruleType) && !spec.ruleText) {
      errors.push({
        field: `${prefix}.rule_text`,
        message: `Rule text is required for a "${spec.ruleType}" tag`,
        code: 'required',
      })
    }

    if (spec.color && !/^#?[0-9a-fA-F]{6}$/.test(spec.color)) {
      errors.push({
        field: `${prefix}.color`,
        message: 'Color must be a 6-digit hex code, e.g. #29B4C6',
        code: 'invalid_color',
      })
    }

    if (spec.criticalityScore) {
      const n = Number(spec.criticalityScore)
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        errors.push({
          field: `${prefix}.criticality_score`,
          message: 'Criticality score must be an integer from 1 to 5',
          code: 'invalid_criticality',
        })
      }
    }

    if (spec.name) {
      const key = assetTagKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate tag "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_tag',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
