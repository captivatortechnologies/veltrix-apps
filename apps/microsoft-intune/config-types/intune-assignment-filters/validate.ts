import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/** Device platforms an assignment filter can target (devicePlatformType subset the canvas offers). */
export const ALLOWED_PLATFORMS = [
  'android',
  'androidForWork',
  'androidWorkProfile',
  'androidAOSP',
  'iOS',
  'macOS',
  'windowsPhone81',
  'windows81AndLater',
  'windows10AndLater',
] as const

/** Filter management types (assignmentFilterManagementType). */
export const ALLOWED_MANAGEMENT_TYPES = ['devices', 'apps'] as const

/** Case-insensitive lookup to the canonical (Graph-cased) platform value. */
const PLATFORM_BY_LOWER = new Map(ALLOWED_PLATFORMS.map((p) => [p.toLowerCase(), p as string]))

/** Resolve a user-entered platform to its canonical Graph casing, or '' if unknown. */
export function canonicalPlatform(value: string): string {
  return PLATFORM_BY_LOWER.get(value.trim().toLowerCase()) ?? ''
}

export interface FilterSpec {
  sectionName: string
  name: string
  description: string
  platform: string
  managementType: string
  rule: string
  roleScopeTags: string[]
}

/** The filter name (displayName) is the reconciliation key. */
export function filterKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a tags/list field into a trimmed string array (accepts a comma string too). */
function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** Each canvas item is one assignment filter: name + platform + management type + rule. */
export function extractFilterSpecs(canvas: CanvasSnapshot): FilterSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.filter_name),
      description: str(fields.description),
      platform: str(fields.platform),
      managementType: str(fields.management_type) || 'devices',
      rule: str(fields.rule),
      roleScopeTags: readList(fields.role_scope_tags),
    }
  })
}

/**
 * Validate assignment filters: each needs a name (unique across the canvas), a
 * non-empty rule, a platform in the allowed set and a management type in the
 * allowed set. The rule DSL grammar is enforced by Intune — we only require it to
 * be present, never parse it here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no assignment filter items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFilterSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.filter_name`, message: 'Filter name is required', code: 'required' })
    } else {
      const key = filterKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.filter_name`, message: `Duplicate filter name "${spec.name}"`, code: 'duplicate_filter' })
      }
      seen.add(key)
    }

    if (!spec.rule) {
      errors.push({ field: `${prefix}.rule`, message: 'Filter rule is required', code: 'required' })
    }

    if (!canonicalPlatform(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${ALLOWED_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    if (!(ALLOWED_MANAGEMENT_TYPES as readonly string[]).includes(spec.managementType)) {
      errors.push({
        field: `${prefix}.management_type`,
        message: `Management type must be one of: ${ALLOWED_MANAGEMENT_TYPES.join(', ')}`,
        code: 'invalid_management_type',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
