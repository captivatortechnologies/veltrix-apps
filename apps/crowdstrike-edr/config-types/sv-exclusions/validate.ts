import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface SvExclusionSpec {
  sectionName: string
  value: string
  appliedGlobally: boolean
  hostGroups: string[]
  comment?: string
}

/** Each canvas section describes one sensor visibility exclusion. */
export function extractSvExclusionSpecs(canvas: CanvasSnapshot): SvExclusionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      value: typeof fields.value === 'string' ? fields.value.trim() : '',
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
 * Validate sensor visibility exclusion configurations: a unique glob-path
 * value and host-group targeting when not applied globally. Applying globally
 * suppresses sensor telemetry broadly, so it is warned about rather than blocked.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSvExclusionSpecs(ctx.canvas)
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

    // host group targeting
    if (!spec.appliedGlobally && spec.hostGroups.length === 0) {
      errors.push({
        field: `${prefix}.hostGroups`,
        message: 'Host group IDs are required when the exclusion is not applied globally',
        code: 'required',
      })
    }
    if (spec.appliedGlobally) {
      if (spec.hostGroups.length > 0) {
        warnings.push({
          field: `${prefix}.hostGroups`,
          message: 'Host groups are ignored while "Apply Globally" is checked',
          code: 'host_groups_ignored',
        })
      }
      // A global sensor visibility exclusion blinds the sensor to the matching
      // path on EVERY host — surface that rather than silently accept it.
      warnings.push({
        field: `${prefix}.appliedGlobally`,
        message: `Applying "${spec.value}" globally suppresses sensor telemetry on the matching path across every host in the tenant`,
        code: 'global_telemetry_suppression',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
