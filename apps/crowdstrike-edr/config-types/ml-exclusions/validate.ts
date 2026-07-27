import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- ML Exclusions API constraints -------------------------------------------

/** What an ML exclusion can suppress. */
export const ML_EXCLUDED_FROM = ['blocking', 'extraction'] as const
export type MlExcludedFrom = (typeof ML_EXCLUDED_FROM)[number]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface MlExclusionSpec {
  sectionName: string
  value: string
  excludedFrom: string[]
  appliedGlobally: boolean
  hostGroups: string[]
  comment?: string
}

/** Each canvas section describes one ML exclusion. */
export function extractMlExclusionSpecs(canvas: CanvasSnapshot): MlExclusionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const excludedFrom = splitList(fields.excludedFrom).map((v) => v.toLowerCase())
    return {
      sectionName: section.name,
      value: typeof fields.value === 'string' ? fields.value.trim() : '',
      // "blocking" is the safe default — an exclusion that suppresses nothing is
      // meaningless, and blocking is the field the API applies by default.
      excludedFrom: excludedFrom.length > 0 ? excludedFrom : ['blocking'],
      appliedGlobally: coerceBoolean(fields.appliedGlobally, false),
      hostGroups: splitList(fields.hostGroups),
      comment:
        typeof fields.comment === 'string' && fields.comment.trim()
          ? fields.comment.trim()
          : undefined,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate ML exclusion configurations against ML Exclusions API constraints:
 * a unique glob-path value, recognized excluded-from sources, and host-group
 * targeting when the exclusion is not applied globally.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMlExclusionSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // value (glob path identity)
    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Exclusion value (glob path) is required', code: 'required' })
    } else if (seen.has(spec.value)) {
      errors.push({
        field: `${prefix}.value`,
        message: `Duplicate exclusion "${spec.value}" — each value may only be declared once per canvas`,
        code: 'duplicate_exclusion',
      })
    }
    seen.add(spec.value)

    // excluded_from
    for (const source of spec.excludedFrom) {
      if (!(ML_EXCLUDED_FROM as readonly string[]).includes(source)) {
        errors.push({
          field: `${prefix}.excludedFrom`,
          message: `Unknown excluded-from source "${source}" — allowed: ${ML_EXCLUDED_FROM.join(', ')}`,
          code: 'invalid_excluded_from',
        })
      }
    }

    // host group targeting
    if (!spec.appliedGlobally && spec.hostGroups.length === 0) {
      errors.push({
        field: `${prefix}.hostGroups`,
        message: 'Host group IDs are required when the exclusion is not applied globally',
        code: 'required',
      })
    }
    if (spec.appliedGlobally && spec.hostGroups.length > 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message: 'Host groups are ignored while "Apply Globally" is checked',
        code: 'host_groups_ignored',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
