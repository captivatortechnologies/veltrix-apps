import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'

// --- IOA Exclusions API constraints ------------------------------------------

/** Falcon truncates exclusion regex fields beyond this length. */
export const IOA_REGEX_MAX_LENGTH = 256

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface IoaExclusionSpec {
  sectionName: string
  name: string
  description?: string
  patternId: string
  patternName?: string
  clRegex: string
  ifnRegex: string
  appliedGlobally: boolean
  hostGroups: string[]
  comment?: string
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const optional = (value: unknown): string | undefined => str(value) || undefined

/** Each canvas section describes one IOA exclusion. */
export function extractIoaExclusionSpecs(canvas: CanvasSnapshot): IoaExclusionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: optional(fields.description),
      patternId: str(fields.patternId),
      patternName: optional(fields.patternName),
      clRegex: str(fields.clRegex),
      ifnRegex: str(fields.ifnRegex),
      appliedGlobally: coerceBoolean(fields.appliedGlobally, false),
      hostGroups: splitList(fields.hostGroups),
      comment: optional(fields.comment),
    }
  })
}

/** True when a value compiles as a JavaScript regular expression. */
export function regexCompiles(pattern: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate IOA exclusion configurations against IOA Exclusions API constraints:
 * a unique name, a target pattern id, command-line and image-filename regexes
 * that compile and fit the length limit, and host-group targeting when the
 * exclusion is not applied globally.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractIoaExclusionSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Exclusion name is required', code: 'required' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate exclusion name "${spec.name}" — each name may only be declared once per canvas`,
        code: 'duplicate_exclusion',
      })
    }
    seen.add(spec.name.toLowerCase())

    // pattern id (required by the API)
    if (!spec.patternId) {
      errors.push({ field: `${prefix}.patternId`, message: 'Pattern ID is required', code: 'required' })
    }

    // command-line and image-filename regexes
    validateRegexField(errors, warnings, `${prefix}.clRegex`, 'Command line regex', spec.clRegex)
    validateRegexField(errors, warnings, `${prefix}.ifnRegex`, 'Image filename regex', spec.ifnRegex)

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

function validateRegexField(
  errors: ValidationResult['errors'],
  warnings: ValidationResult['warnings'],
  field: string,
  label: string,
  value: string,
): void {
  if (!value) {
    errors.push({ field, message: `${label} is required (use .* to match any)`, code: 'required' })
    return
  }
  if (!regexCompiles(value)) {
    errors.push({ field, message: `${label} is not a valid regular expression`, code: 'invalid_regex' })
  }
  if (value.length > IOA_REGEX_MAX_LENGTH) {
    warnings.push({
      field,
      message: `${label} exceeds ${IOA_REGEX_MAX_LENGTH} characters and will be truncated by Falcon`,
      code: 'regex_too_long',
    })
  }
}
