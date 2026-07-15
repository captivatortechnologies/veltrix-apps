import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Scanner Groups API constraints ----------------------------------

/** A scanner group name is capped at 255 characters. */
export const MAX_SCANNER_GROUP_NAME_LENGTH = 255

/**
 * Scanner groups are created as load-balancing pools. The Tenable Scanner Groups
 * API models "type" as an enum, but for Tenable VM it is effectively always
 * "load_balancing" — deploy sends this on create and never changes it.
 */
export const SCANNER_GROUP_TYPE = 'load_balancing'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ScannerGroupSpec {
  sectionName: string
  /** The group name — the logical identity (matched to a numeric id on deploy). */
  name: string
}

/** Shape of a scanner group ("scanner pool") returned by GET /scanner-groups. */
export interface LiveScannerGroup {
  id?: number | string
  uuid?: string
  name?: string
  type?: string
}

/** Each canvas item describes one Tenable scanner group. */
export function extractScannerGroupSpecs(canvas: CanvasSnapshot): ScannerGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate scanner group configurations against Scanner Groups API constraints:
 * a name is required, capped at 255 characters, and — because the name is the
 * group's logical identity — must be unique within the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractScannerGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique within the canvas
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Scanner group name is required', code: 'required' })
      continue
    }

    if (spec.name.length > MAX_SCANNER_GROUP_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Scanner group name must be ${MAX_SCANNER_GROUP_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // The name is the group's logical identity — dedupe on it. Matched
    // case-insensitively so two groups differing only in case are not both
    // declared (deploy would otherwise adopt an ambiguous live match).
    const key = spec.name.toLowerCase()
    if (seenNames.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate scanner group "${spec.name}" — each group may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)
  }

  return { valid: errors.length === 0, errors, warnings }
}
